# Complete Refactored AP eProcurement Scraper

import sqlite3
import time
import os
import traceback
import json
import base64
import multiprocessing
import re
import requests
from datetime import datetime
from urllib.parse import unquote, urljoin, urlparse

from selenium import webdriver
from selenium.webdriver import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import (
    UnexpectedAlertPresentException,
    NoSuchElementException
)


DEEP_SCRAPE_WORKERS = int(os.environ.get("DEEP_SCRAPE_WORKERS", "10"))
MAX_TENDER_RETRIES = int(os.environ.get("MAX_TENDER_RETRIES", "3"))
RETRY_WAIT_SECONDS = int(os.environ.get("RETRY_WAIT_SECONDS", "30"))
SCRAPER_INTERVAL_SECONDS = int(os.environ.get("SCRAPER_INTERVAL_SECONDS", "18000"))
RUN_SCRAPER_ONCE = os.environ.get("RUN_SCRAPER_ONCE", "0") == "1"
MAX_DOCUMENT_DOWNLOAD_BYTES = 25 * 1024 * 1024
SQLITE_BUSY_TIMEOUT_MS = int(os.environ.get("SQLITE_BUSY_TIMEOUT_MS", "120000"))
DB_WRITE_GAP_SECONDS = float(os.environ.get("DB_WRITE_GAP_SECONDS", "2"))
DB_WRITE_RETRIES = int(os.environ.get("DB_WRITE_RETRIES", "8"))
DB_WORKER_START_GAP_SECONDS = float(os.environ.get("DB_WORKER_START_GAP_SECONDS", "3"))
SCRAPER_TEST_LIMIT = int(os.environ.get("SCRAPER_TEST_LIMIT", "0"))
MAX_PAGES = int(os.environ.get("MAX_PAGES", "0"))


# =========================================================
# DATABASE SETUP
# =========================================================

def setup_database():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(script_dir, 'tenders.db')

    print(f"[SYSTEM] Connecting DB: {db_path}")

    conn = sqlite3.connect(db_path, timeout=120)
    cursor = conn.cursor()

    cursor.execute("PRAGMA journal_mode=WAL;")
    cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS};")

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS tenders (
            department TEXT,
            tender_id TEXT PRIMARY KEY,
            tender_notice_number TEXT,
            tender_category TEXT,
            title TEXT,
            est_value TEXT,
            start_date TEXT,
            closing_date TEXT,
            tender_details TEXT,
            boq_link TEXT,
            document_link TEXT,
            scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute("PRAGMA table_info(tenders)")
    existing_columns = {row[1] for row in cursor.fetchall()}

    if "document_files" not in existing_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN document_files TEXT")

    if "eligibility_criteria" not in existing_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN eligibility_criteria TEXT")

    if "enquiry_form_details" not in existing_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN enquiry_form_details TEXT")

    if "is_active" not in existing_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN is_active INTEGER DEFAULT 1")

    if "removed_at" not in existing_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN removed_at TIMESTAMP")

    if "last_seen_at" not in existing_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN last_seen_at TIMESTAMP")

    conn.commit()

    print("[SYSTEM] DB Ready")

    return conn, db_path


def get_worker_number(worker_label):
    match = re.search(r"(\d+)", str(worker_label or "1"))
    return int(match.group(1)) if match else 1


def wait_for_worker_write_slot(worker_label):
    worker_number = get_worker_number(worker_label)
    delay = max(0, worker_number - 1) * DB_WRITE_GAP_SECONDS

    if delay:
        print(f"[{worker_label}] DB write gap: waiting {delay:.1f}s")
        time.sleep(delay)


def execute_db_write(conn, cursor, sql, params, worker_label="W1"):
    for attempt in range(1, DB_WRITE_RETRIES + 1):
        try:
            wait_for_worker_write_slot(worker_label)
            cursor.execute(sql, params)
            conn.commit()
            return True

        except sqlite3.OperationalError as e:
            if "locked" not in str(e).lower() or attempt == DB_WRITE_RETRIES:
                raise

            wait_for = DB_WRITE_GAP_SECONDS * attempt
            print(f"[{worker_label}] Database locked. Retry {attempt}/{DB_WRITE_RETRIES} after {wait_for:.1f}s")
            time.sleep(wait_for)

    return False


# =========================================================
# CHROME DRIVER
# =========================================================

def build_driver(download_dir=None):
    options = webdriver.ChromeOptions()

    options.add_argument('--start-maximized')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')

    if download_dir:
        os.makedirs(download_dir, exist_ok=True)
        options.add_experimental_option("prefs", {
            "download.default_directory": os.path.abspath(download_dir),
            "download.prompt_for_download": False,
            "download.directory_upgrade": True,
            "safebrowsing.enabled": True,
            "plugins.always_open_pdf_externally": True,
        })

    # Run headless on Linux/Servers by default, and allow override via env variable
    is_linux = os.name != 'nt'
    default_headless = '1' if is_linux else '0'
    if os.environ.get('HEADLESS', default_headless) == '1':
        options.add_argument('--headless=new')
        options.add_argument('--disable-gpu')

    driver = webdriver.Chrome(options=options)

    if download_dir:
        try:
            driver.execute_cdp_cmd(
                "Page.setDownloadBehavior",
                {
                    "behavior": "allow",
                    "downloadPath": os.path.abspath(download_dir),
                }
            )
        except Exception as e:
            print(f"[DOWNLOAD] Could not configure CDP download behavior: {e}")

    return driver


# =========================================================
# PORTAL HELPERS
# =========================================================

def kill_modals(driver):
    try:
        driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
        time.sleep(1)

        driver.execute_script("""
            var elements = document.querySelectorAll('*');

            for (var i = 0; i < elements.length; i++) {
                var style = window.getComputedStyle(elements[i]);

                if (style.zIndex > 100 || style.position === 'fixed') {
                    elements[i].style.visibility = 'hidden';
                }
            }
        """)

    except:
        pass



def switch_main_frame(driver):
    driver.switch_to.default_content()

    frames = driver.find_elements(By.TAG_NAME, "frame") + \
             driver.find_elements(By.TAG_NAME, "iframe")

    if frames:
        driver.switch_to.frame(frames[0])



def load_main_table(driver):
    print("[SYSTEM] Loading main tender table...")

    driver.get("https://tender.apeprocurement.gov.in/login.html")

    time.sleep(5)

    kill_modals(driver)

    switch_main_frame(driver)

    try:
        more_btn = WebDriverWait(driver, 15).until(
            EC.presence_of_element_located(
                (By.XPATH, "//a[contains(text(),'More')]")
            )
        )

        driver.execute_script("arguments[0].click();", more_btn)

        WebDriverWait(driver, 20).until(
            EC.presence_of_element_located((By.TAG_NAME, "table"))
        )

        time.sleep(3)

        return True

    except Exception as e:
        print(f"[ERROR] Could not load table: {e}")
        return False


# =========================================================
# PHASE 1
# =========================================================

def find_active_next_button(driver):
    next_buttons = driver.find_elements(
        By.XPATH,
        """
        //a[
            contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@title, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@class, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@id, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
        ]
        |
        //button[
            contains(translate(normalize-space(.), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@title, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@class, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@id, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
        ]
        |
        //img[
            contains(translate(@src, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@title, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@alt, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
        ]
        |
        //img[
            contains(translate(@src, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@title, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@alt, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
            or contains(translate(@aria-label, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')
        ]/ancestor::*[self::a or self::button][1]
        """
    )

    for btn in next_buttons:

        try:
            if not btn.is_displayed():
                continue

            btn_class = (btn.get_attribute("class") or "").lower()
            btn_style = (btn.get_attribute("style") or "").lower()
            aria_disabled = (btn.get_attribute("aria-disabled") or "").lower()
            disabled = (btn.get_attribute("disabled") or "").lower()
            href = (btn.get_attribute("href") or "").lower()
            onclick = (btn.get_attribute("onclick") or "").lower()
            btn_id = (btn.get_attribute("id") or "").lower()
            btn_text = (btn.text or "").strip()
            tag_name = (btn.tag_name or "").lower()

            print(
                "[PAGE] Next candidate:",
                f"tag={tag_name}",
                f"id={btn_id or '-'}",
                f"class={btn_class or '-'}",
                f"text={btn_text or '-'}",
                f"href={href or '-'}",
                f"onclick={'yes' if onclick else 'no'}"
            )

            if (
                "disabled" in btn_class
                or "aspnetdisabled" in btn_class
                or "ui-state-disabled" in btn_class
                or "disabled" in btn_style
                or "pointer-events: none" in btn_style
                or aria_disabled == "true"
                or disabled
            ):
                print("[PAGE] Skipping disabled Next candidate")
                continue

            print("[PAGE] Active Next button found")
            return btn

        except:
            continue

    print("[PAGE] Checked Next button candidates, none active")
    return None


def get_results_page_signature(driver):
    try:
        rows_text = []

        for table in driver.find_elements(By.TAG_NAME, "table"):
            for row in table.find_elements(By.TAG_NAME, "tr"):
                text = row.text.strip()
                if text:
                    rows_text.append(text)

        return "|".join(rows_text[:25])

    except:
        return ""


def wait_for_results_change(driver, previous_signature, timeout=20):
    end_time = time.time() + timeout

    while time.time() < end_time:
        time.sleep(1)
        current_signature = get_results_page_signature(driver)

        if current_signature and current_signature != previous_signature:
            return True

    return False


def save_next_debug_snapshot(driver):
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        html_path = os.path.join(script_dir, "next_button_debug.html")
        screenshot_path = os.path.join(script_dir, "next_button_debug.png")

        with open(html_path, "w", encoding="utf-8") as file:
            file.write(driver.page_source)

        driver.save_screenshot(screenshot_path)

        print(f"[DEBUG] Saved Next button HTML: {html_path}")
        print(f"[DEBUG] Saved Next button screenshot: {screenshot_path}")

    except Exception as e:
        print(f"[DEBUG] Could not save Next button snapshot: {e}")


def scrape_tenders(max_pages=None):
    if max_pages is None and SCRAPER_TEST_LIMIT > 0:
        max_pages = 1

    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] PHASE 1 START")

    driver = build_driver()

    scraped_data = []

    try:

        if not load_main_table(driver):
            return []

        page_count = 1

        while True:

            print(f"[PAGE] Scraping page {page_count}")

            try:
                all_tables = driver.find_elements(By.TAG_NAME, "table")

                page_scraped = 0

                for table in all_tables:
                    rows = table.find_elements(By.TAG_NAME, "tr")

                    for row in rows:

                        try:
                            cols = row.find_elements(By.TAG_NAME, "td")

                            if len(cols) >= 8:

                                t_dept = cols[0].text.strip()
                                t_id = cols[1].text.strip()
                                t_notice = cols[2].text.strip()
                                t_cat = cols[3].text.strip()
                                t_title = cols[4].text.strip()
                                t_val = cols[5].text.strip()
                                t_start = cols[6].text.strip()
                                t_close = cols[7].text.strip()

                                if t_id and t_id.isdigit():

                                    scraped_data.append((
                                        t_dept,
                                        t_id,
                                        t_notice,
                                        t_cat,
                                        t_title,
                                        t_val,
                                        t_start,
                                        t_close,
                                        'Pending Deep Extraction',
                                        '',
                                        ''
                                    ))

                                    page_scraped += 1

                        except:
                            continue

                print(f"[PAGE] Found {page_scraped} tenders")

                active_btn = find_active_next_button(driver)

                if active_btn:
                    previous_signature = get_results_page_signature(driver)

                    driver.execute_script(
                        "arguments[0].scrollIntoView({block: 'center'});",
                        active_btn
                    )
                    time.sleep(1)

                    print("[PAGE] Clicking Next button...")
                    driver.execute_script("arguments[0].click();", active_btn)

                    if not wait_for_results_change(driver, previous_signature):
                        print("[PAGE] Next button did not change results. Stopping at final page.")
                        break

                    page_count += 1
                    print(f"[PAGE] Moved to page {page_count}")

                    if max_pages and page_count > max_pages:
                        print(f"[PAGE] Reached max_pages={max_pages}. Stopping.")
                        break

                else:
                    print("[PAGE] No active Next button found. Reached final page.")
                    save_next_debug_snapshot(driver)
                    break

            except UnexpectedAlertPresentException:
                try:
                    driver.switch_to.alert.accept()
                except:
                    pass

                break

        final_data = list(set(scraped_data))

        print(f"[SUMMARY] Total scraped: {len(final_data)}")

        return final_data

    except Exception:
        traceback.print_exc()
        return []

    finally:
        driver.quit()


def sync_phase1_tenders(db_path, scraped):
    scraped = scraped or []
    live_ids = {row[1] for row in scraped}

    conn = sqlite3.connect(db_path, timeout=120)
    cursor = conn.cursor()
    cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS};")

    cursor.execute("SELECT tender_id FROM tenders")
    existing_ids = {row[0] for row in cursor.fetchall()}

    cursor.execute("SELECT tender_id FROM tenders WHERE COALESCE(is_active, 1)=1")
    previously_active_ids = {row[0] for row in cursor.fetchall()}

    new_ids = live_ids - existing_ids
    removed_ids = previously_active_ids - live_ids
    returned_ids = live_ids & (existing_ids - previously_active_ids)

    for row in scraped:
        cursor.execute(
            """
            INSERT OR IGNORE INTO tenders (
                department,
                tender_id,
                tender_notice_number,
                tender_category,
                title,
                est_value,
                start_date,
                closing_date,
                tender_details,
                boq_link,
                document_link,
                document_files,
                is_active,
                removed_at,
                last_seen_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, NULL, CURRENT_TIMESTAMP)
            """,
            row
        )

        cursor.execute(
            """
            UPDATE tenders
            SET
                department=?,
                tender_notice_number=?,
                tender_category=?,
                title=?,
                est_value=?,
                start_date=?,
                closing_date=?,
                scraped_at=CURRENT_TIMESTAMP,
                last_seen_at=CURRENT_TIMESTAMP,
                is_active=1,
                removed_at=NULL
            WHERE tender_id=?
            """,
            (
                row[0],
                row[2],
                row[3],
                row[4],
                row[5],
                row[6],
                row[7],
                row[1]
            )
        )

    if removed_ids:
        cursor.executemany(
            """
            UPDATE tenders
            SET is_active=0,
                removed_at=CURRENT_TIMESTAMP
            WHERE tender_id=?
            """,
            [(tender_id,) for tender_id in removed_ids]
        )

    conn.commit()
    conn.close()

    print(
        "[DB] Phase 1 sync:",
        f"live={len(live_ids)}",
        f"new={len(new_ids)}",
        f"removed={len(removed_ids)}",
        f"returned={len(returned_ids)}"
    )

    return {
        "live": len(live_ids),
        "new": len(new_ids),
        "removed": len(removed_ids),
        "returned": len(returned_ids)
    }


# =========================================================
# CLICK EXECUTOR
# =========================================================

def execute_portal_action(driver, xpath_query, label="Unknown"):

    try:

        switch_main_frame(driver)

        elements = driver.find_elements(By.XPATH, xpath_query)

        if not elements:
            print(f"      -> {label}: No elements found")
            return False

        valid_element = None

        for el in elements:

            try:
                if not el.is_displayed():
                    continue

                th_parent = el.find_elements(
                    By.XPATH,
                    "ancestor-or-self::th"
                )

                if th_parent:
                    continue

                tag = el.tag_name.lower()

                if tag not in ['a', 'img', 'button', 'input']:
                    continue

                valid_element = el
                break

            except:
                continue

        if not valid_element:
            print(f"      -> {label}: No clickable element")
            return False

        href = valid_element.get_attribute("href") or ""
        onclick = valid_element.get_attribute("onclick") or ""

        payload = None

        if href.startswith("javascript:"):
            payload = href.replace("javascript:", "")

        elif onclick:
            payload = onclick

        existing_windows = set(driver.window_handles)

        if payload:
            print(f"      -> {label}: Executing JS payload")
            driver.execute_script(payload)

        else:
            print(f"      -> {label}: Using JS click")
            driver.execute_script(
                "arguments[0].click();",
                valid_element
            )

        time.sleep(5)

        new_windows = set(driver.window_handles) - existing_windows

        if new_windows:
            return list(new_windows)[0]

        return "same_window"

    except Exception as e:
        print(f"      -> {label} failed: {e}")
        return False


# =========================================================
# TABLE EXTRACTION
# =========================================================

def extract_tables_json(driver):

    all_tables = []

    try:

        switch_main_frame(driver)

        time.sleep(2)

        # deep scrolling
        last_height = driver.execute_script(
            "return document.body.scrollHeight"
        )

        for _ in range(15):

            driver.execute_script("""
                window.scrollTo(0, document.body.scrollHeight);

                var elements = document.querySelectorAll('*');

                for (var i = 0; i < elements.length; i++) {
                    if (elements[i].scrollHeight > elements[i].clientHeight) {
                        elements[i].scrollTop = elements[i].scrollHeight;
                    }
                }
            """)

            time.sleep(1.5)

            new_height = driver.execute_script(
                "return document.body.scrollHeight"
            )

            if new_height == last_height:
                break

            last_height = new_height

        tables = driver.find_elements(By.TAG_NAME, "table")

        for table in tables:

            table_data = []

            rows = table.find_elements(By.TAG_NAME, "tr")

            for row in rows:

                row_data = []

                cols = row.find_elements(By.XPATH, ".//td | .//th")

                for col in cols:

                    try:
                        text = col.text.strip().replace('\n', ' ')

                        links = col.find_elements(By.TAG_NAME, "a")

                        for link in links:
                            href = link.get_attribute("href") or ""
                            onclick = link.get_attribute("onclick") or ""
                            title = link.get_attribute("title") or link.get_attribute("aria-label") or ""

                            if onclick:
                                text += f" [View Details: {onclick}]"
                            elif title:
                                text += f" [View Details: {title}]"
                            elif href and not href.endswith("#"):
                                text += f" [Link: {href}]"

                        clickables = col.find_elements(By.XPATH, ".//*[self::img or self::button or self::input]")

                        for clickable in clickables:
                            onclick = clickable.get_attribute("onclick") or ""
                            title = clickable.get_attribute("title") or clickable.get_attribute("alt") or clickable.get_attribute("aria-label") or ""

                            if onclick:
                                text += f" [View Details: {onclick}]"
                            elif title and "view" in title.lower():
                                text += f" [View Details: {title}]"

                        row_data.append(text)

                    except:
                        row_data.append("")

                if any(cell.strip() for cell in row_data):
                    table_data.append(row_data)

            if table_data:
                all_tables.append(table_data)

        # isolated ZIP detectors
        anchors = driver.find_elements(By.TAG_NAME, "a")

        zip_rows = []

        for a in anchors:

            try:
                href = a.get_attribute("href") or ""
                text = a.text.strip()

                if 'zip' in href.lower() or 'bulk' in text.lower():
                    zip_rows.append([
                        text,
                        href
                    ])

            except:
                pass

        if zip_rows:
            all_tables.append([["Bulk Download Links"]])

            for row in zip_rows:
                all_tables.append([row])

    except Exception as e:
        print(f"[ERROR] Table extraction failed: {e}")

    return json.dumps(all_tables, ensure_ascii=False)


def extract_urls_from_text(value):
    if not isinstance(value, str):
        return []

    urls = re.findall(
        r"\[Link:\s*([^\]\s]+)\]|(https?://[^\s\]]+)",
        value
    )

    cleaned_urls = []

    for first, second in urls:
        url = (first or second or "").strip().strip("'\"")

        if url and url not in cleaned_urls:
            cleaned_urls.append(url)

    return cleaned_urls


def extract_document_urls(document_data):
    urls = []

    if not document_data or not isinstance(document_data, str):
        return urls

    for url in extract_urls_from_text(document_data):
        if url not in urls:
            urls.append(url)

    try:
        tables = json.loads(document_data)

        def walk(value):
            if isinstance(value, list):
                for item in value:
                    walk(item)
            elif isinstance(value, str):
                for url in extract_urls_from_text(value):
                    if url not in urls:
                        urls.append(url)

        walk(tables)

    except:
        pass

    return urls


def make_requests_session_from_driver(driver, referer_url=None):
    session = requests.Session()
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "application/octet-stream,application/zip,application/pdf,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": referer_url or driver.current_url,
    })

    try:
        for cookie in driver.get_cookies():
            session.cookies.set(
                cookie.get("name"),
                cookie.get("value"),
                domain=cookie.get("domain")
            )
    except:
        pass

    return session


def get_filename_from_response(url, response, index):
    disposition = response.headers.get("Content-Disposition", "")
    match = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', disposition, re.IGNORECASE)

    if match:
        return unquote(match.group(1).strip())

    parsed_url = urlparse(url)
    filename = unquote(os.path.basename(parsed_url.path))

    return filename or f"tender-document-{index}"


def list_finished_downloads(download_dir):
    if not download_dir or not os.path.isdir(download_dir):
        return set()

    return {
        os.path.join(download_dir, name)
        for name in os.listdir(download_dir)
        if not name.endswith(".crdownload") and not name.endswith(".tmp")
    }


def wait_for_native_downloads(download_dir, before_files, timeout=60):
    end_time = time.time() + timeout
    newest_files = set()

    while time.time() < end_time:
        active_downloads = [
            name
            for name in os.listdir(download_dir)
            if name.endswith(".crdownload") or name.endswith(".tmp")
        ] if os.path.isdir(download_dir) else []

        current_files = list_finished_downloads(download_dir)
        newest_files = current_files - before_files

        if newest_files and not active_downloads:
            return newest_files

        time.sleep(1)

    return newest_files


def file_record_from_path(path, source_url=None):
    with open(path, "rb") as file:
        content = file.read()

    if len(content) > MAX_DOCUMENT_DOWNLOAD_BYTES:
        raise ValueError("Document is larger than allowed database storage limit")

    return {
        "filename": os.path.basename(path),
        "content_type": "application/octet-stream",
        "size": len(content),
        "source_url": source_url,
        "download_method": "browser_click",
        "data_base64": base64.b64encode(content).decode("ascii")
    }


def is_document_download_candidate(element):
    try:
        values = [
            element.text or "",
            element.get_attribute("title") or "",
            element.get_attribute("alt") or "",
            element.get_attribute("href") or "",
            element.get_attribute("onclick") or "",
            element.get_attribute("src") or "",
            element.get_attribute("class") or "",
            element.get_attribute("id") or "",
        ]

        combined = " ".join(values).lower()

        if any(token in combined for token in ["download", "zip", "document", ".pdf", ".xls", ".xlsx", ".doc", ".docx", ".rar"]):
            return True

    except:
        pass

    return False


def download_document_files_with_browser(driver, download_dir, tender_id):
    if not download_dir:
        return []

    os.makedirs(download_dir, exist_ok=True)
    records = []
    current_window = driver.current_window_handle

    elements = driver.find_elements(
        By.XPATH,
        "//*[self::a or self::button or self::input or self::img]"
    )

    candidates = []

    for element in elements:
        try:
            if element.is_displayed() and is_document_download_candidate(element):
                candidates.append(element)
        except:
            continue

    print(f"[DOC BROWSER DOWNLOAD] Found {len(candidates)} clickable candidates")

    for idx, element in enumerate(candidates, start=1):
        try:
            before_files = list_finished_downloads(download_dir)
            before_windows = set(driver.window_handles)
            source_hint = element.get_attribute("href") or element.get_attribute("onclick") or driver.current_url

            print(f"[DOC BROWSER DOWNLOAD] Clicking candidate {idx}: {source_hint}")

            driver.execute_script(
                "arguments[0].scrollIntoView({block: 'center'});",
                element
            )
            time.sleep(1)
            driver.execute_script("arguments[0].click();", element)

            new_files = wait_for_native_downloads(download_dir, before_files)

            new_windows = set(driver.window_handles) - before_windows
            for window_handle in new_windows:
                try:
                    driver.switch_to.window(window_handle)
                    time.sleep(2)
                    new_files.update(wait_for_native_downloads(download_dir, before_files, timeout=10))
                    driver.close()
                except:
                    pass

            if current_window in driver.window_handles:
                driver.switch_to.window(current_window)

            for path in new_files:
                try:
                    record = file_record_from_path(path, source_hint)
                    record["tender_id"] = tender_id
                    records.append(record)
                except Exception as file_error:
                    records.append({
                        "filename": os.path.basename(path),
                        "content_type": "text/plain",
                        "size": 0,
                        "source_url": source_hint,
                        "download_method": "browser_click",
                        "error": str(file_error)
                    })

        except Exception as e:
            print(f"[DOC BROWSER DOWNLOAD ERROR] candidate {idx}: {e}")

    unique_records = []
    seen = set()

    for record in records:
        key = (record.get("filename"), record.get("size"))
        if key not in seen:
            seen.add(key)
            unique_records.append(record)

    return unique_records


def download_document_files(driver, document_data, base_url=None):
    base_url = base_url or driver.current_url

    urls = [
        urljoin(base_url, url)
        for url in extract_document_urls(document_data)
        if (
            url
            and url.strip() != "#"
            and not url.lower().startswith("javascript:")
            and not url.lower().endswith(".html#")
        )
    ]

    if not urls:
        return "[]"

    session = make_requests_session_from_driver(driver, base_url)
    files = []

    for idx, url in enumerate(urls, start=1):
        try:
            print(f"[DOC DOWNLOAD] Downloading {idx}/{len(urls)}: {url}")

            response = session.get(
                url,
                stream=True,
                timeout=60,
                allow_redirects=True
            )
            response.raise_for_status()

            content = bytearray()

            for chunk in response.iter_content(chunk_size=8192):
                if not chunk:
                    continue

                content.extend(chunk)

                if len(content) > MAX_DOCUMENT_DOWNLOAD_BYTES:
                    raise ValueError("Document is larger than allowed database storage limit")

            content_type = response.headers.get("Content-Type", "application/octet-stream")

            if not content:
                raise ValueError("Portal returned an empty file")

            if "text/html" in content_type.lower():
                preview = bytes(content[:300]).decode("utf-8", errors="ignore").strip()
                raise ValueError(f"Portal returned HTML instead of a file: {preview[:120]}")

            filename = get_filename_from_response(url, response, idx)

            files.append({
                "filename": filename,
                "content_type": content_type,
                "size": len(content),
                "source_url": url,
                "data_base64": base64.b64encode(bytes(content)).decode("ascii")
            })

        except Exception as e:
            print(f"[DOC DOWNLOAD ERROR] {url}: {e}")

            files.append({
                "filename": f"download-failed-{idx}",
                "content_type": "text/plain",
                "size": 0,
                "source_url": url,
                "error": str(e)
            })

    return json.dumps(files, ensure_ascii=False)


def merge_document_file_records(browser_records, direct_records_json):
    records = list(browser_records or [])

    try:
        direct_records = json.loads(direct_records_json or "[]")
    except:
        direct_records = []

    records.extend(direct_records)

    unique_records = []
    seen = set()

    for record in records:
        key = (
            record.get("filename"),
            record.get("size"),
            record.get("source_url"),
            bool(record.get("data_base64"))
        )

        if key not in seen:
            seen.add(key)
            unique_records.append(record)

    return json.dumps(unique_records, ensure_ascii=False)


def parse_money_value(value):
    if value is None:
        return 0

    text = str(value).lower().replace(",", "").strip()
    number_match = re.search(r"(\d+(?:\.\d+)?)", text)

    if not number_match:
        return 0

    amount = float(number_match.group(1))

    if "crore" in text or "cr" in text:
        amount *= 10000000
    elif "lakh" in text or "lac" in text:
        amount *= 100000

    return amount


def should_scrape_eligibility_criteria(est_value):
    return parse_money_value(est_value) >= 5000000


def is_works_over_50_lakhs(tender_category, est_value):
    category = str(tender_category or "").strip().lower()
    return "work" in category and should_scrape_eligibility_criteria(est_value)


def save_eligibility_debug_snapshot(driver, tender_id):
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        html_path = os.path.join(script_dir, f"eligibility_debug_{tender_id}.html")
        screenshot_path = os.path.join(script_dir, f"eligibility_debug_{tender_id}.png")

        with open(html_path, "w", encoding="utf-8") as file:
            file.write(driver.page_source)

        driver.save_screenshot(screenshot_path)

        print(f"[ELIGIBILITY DEBUG] Saved HTML: {html_path}")
        print(f"[ELIGIBILITY DEBUG] Saved screenshot: {screenshot_path}")

    except Exception as e:
        print(f"[ELIGIBILITY DEBUG] Could not save debug snapshot: {e}")


def get_clickable_target(element):
    try:
        ancestor = element.find_element(
            By.XPATH,
            "./ancestor-or-self::*[self::a or self::button or self::input or @onclick][1]"
        )
        return ancestor
    except:
        return element


def find_eligibility_window(driver, preferred_windows):
    handles = list(preferred_windows) + [
        handle for handle in driver.window_handles if handle not in preferred_windows
    ]

    for handle in handles:
        try:
            driver.switch_to.window(handle)
            time.sleep(1)
            page_text = driver.page_source.lower()

            if (
                "view eligibility criteria" in page_text
                or "eligibility criteria" in page_text and "enquiry forms" not in page_text
            ):
                return handle

        except:
            continue

    return None


def click_enquiry_row_by_form_name(driver, form_name):
    return driver.execute_script("""
        var formName = arguments[0];
        var rows = Array.from(document.querySelectorAll('tr'));
        var row = rows.find(function(item) {
            return (item.innerText || item.textContent || '').toLowerCase().indexOf(formName.toLowerCase()) !== -1;
        });

        if (!row) {
            return 'row-not-found';
        }

        var cells = Array.from(row.querySelectorAll('td,th'));
        var cell = cells[cells.length - 1];

        if (!cell) {
            return 'last-cell-not-found';
        }

        var target =
            cell.querySelector('a[onclick]') ||
            cell.querySelector('button[onclick]') ||
            cell.querySelector('a') ||
            cell.querySelector('button') ||
            cell.querySelector('input') ||
            cell.querySelector('img') ||
            cell;

        if (target.tagName && target.tagName.toLowerCase() === 'img') {
            target = target.closest('a,button,input,[onclick]') || target;
        }

        target.scrollIntoView({ block: 'center' });
        target.click();
        return 'clicked';
    """, form_name)


def try_open_eligibility_candidate(driver, candidate, popup_window, form_name=None):
    click_target = get_clickable_target(candidate)
    before_signature = get_results_page_signature(driver)
    existing_windows = set(driver.window_handles)

    onclick_values = []

    for element in [candidate, click_target]:
        try:
            onclick = element.get_attribute("onclick") or ""
            if onclick and onclick not in onclick_values:
                onclick_values.append(onclick)
        except:
            pass

    try:
        parent = candidate.find_element(By.XPATH, "./ancestor::*[@onclick][1]")
        parent_onclick = parent.get_attribute("onclick") or ""
        if parent_onclick and parent_onclick not in onclick_values:
            onclick_values.append(parent_onclick)
    except:
        pass

    click_attempts = []

    if form_name:
        click_attempts.append(
            ("dom_exact_row", lambda: click_enquiry_row_by_form_name(driver, form_name))
        )

    for onclick in onclick_values:
        click_attempts.append(("onclick", lambda value=onclick: driver.execute_script(value)))

    click_attempts.extend([
        ("native", lambda: ActionChains(driver).move_to_element(click_target).pause(0.2).click(click_target).perform()),
        ("element_click", lambda: click_target.click()),
        ("js_click", lambda: driver.execute_script("arguments[0].click();", click_target)),
    ])

    for label, action in click_attempts:
        try:
            print(f"[ELIGIBILITY] Trying {label} click")
            driver.execute_script(
                "arguments[0].scrollIntoView({block: 'center'});",
                click_target
            )
            time.sleep(1)

            action()
            time.sleep(4)

            new_windows = set(driver.window_handles) - existing_windows
            eligibility_window = find_eligibility_window(
                driver,
                list(new_windows) + [popup_window]
            )

            if not eligibility_window:
                eligibility_window = popup_window
                driver.switch_to.window(eligibility_window)

            time.sleep(2)
            eligibility_data = extract_tables_json(driver)
            after_signature = get_results_page_signature(driver)

            if eligibility_window != popup_window:
                driver.close()
                driver.switch_to.window(popup_window)

            if eligibility_window == popup_window and eligibility_data and after_signature == before_signature:
                print(f"[ELIGIBILITY] {label} click left enquiry table unchanged")
                continue

            if eligibility_data and "Eligibility Criteria" in eligibility_data:
                return eligibility_data

            if eligibility_data and "Enquiry Forms" not in eligibility_data:
                return eligibility_data

        except Exception as e:
            print(f"[ELIGIBILITY] {label} click failed: {e}")
            try:
                driver.switch_to.window(popup_window)
            except:
                pass

    return None


def normalize_form_detail_data(raw_data):
    if not raw_data:
        return None

    try:
        parsed = json.loads(raw_data)
        if isinstance(parsed, list):
            return parsed
    except:
        pass

    return [[[raw_data]]]


def looks_like_parent_enquiry_table(raw_data):
    if not raw_data:
        return True

    text = str(raw_data).lower()
    return "enquiry forms" in text and ("form name" in text or "view details" in text)


def find_opened_detail_window(driver, previous_windows, popup_window, form_name):
    candidate_windows = [
        handle for handle in driver.window_handles if handle not in previous_windows
    ] + [popup_window]

    form_name_lower = (form_name or "").lower()

    for handle in candidate_windows:
        try:
            driver.switch_to.window(handle)
            time.sleep(1)
            page_text = driver.page_source.lower()

            if looks_like_parent_enquiry_table(page_text):
                continue

            if form_name_lower and form_name_lower in page_text:
                return handle

            if "current tender details" in page_text:
                return handle

        except:
            continue

    return None


def restore_enquiry_forms_page(driver, popup_window):
    try:
        driver.switch_to.window(popup_window)
        page_text = driver.page_source.lower()

        if not looks_like_parent_enquiry_table(page_text):
            close_result = driver.execute_script("""
                var buttons = Array.from(document.querySelectorAll('button,input,a'));
                var closeButton = buttons.find(function(item) {
                    var text = (item.innerText || item.value || item.title || '').trim().toLowerCase();
                    return text === 'close';
                });

                if (closeButton) {
                    closeButton.click();
                    return 'clicked-close';
                }

                return 'close-not-found';
            """)

            time.sleep(2)

            if close_result != "clicked-close" or not looks_like_parent_enquiry_table(driver.page_source.lower()):
                driver.back()
                time.sleep(2)

    except Exception as e:
        print(f"[ENQUIRY FORM] Could not restore parent enquiry form page: {e}")


def try_open_enquiry_form_candidate(driver, candidate, popup_window, form_name):
    click_target = get_clickable_target(candidate)
    before_signature = get_results_page_signature(driver)
    existing_windows = set(driver.window_handles)

    onclick_values = []

    for element in [candidate, click_target]:
        try:
            onclick = element.get_attribute("onclick") or ""
            if onclick and onclick not in onclick_values:
                onclick_values.append(onclick)
        except:
            pass

    try:
        parent = candidate.find_element(By.XPATH, "./ancestor::*[@onclick][1]")
        parent_onclick = parent.get_attribute("onclick") or ""
        if parent_onclick and parent_onclick not in onclick_values:
            onclick_values.append(parent_onclick)
    except:
        pass

    click_attempts = [
        ("dom_exact_row", lambda: click_enquiry_row_by_form_name(driver, form_name))
    ]

    for onclick in onclick_values:
        click_attempts.append(("onclick", lambda value=onclick: driver.execute_script(value)))

    click_attempts.extend([
        ("native", lambda: ActionChains(driver).move_to_element(click_target).pause(0.2).click(click_target).perform()),
        ("element_click", lambda: click_target.click()),
        ("js_click", lambda: driver.execute_script("arguments[0].click();", click_target)),
    ])

    for label, action in click_attempts:
        detail_window = None

        try:
            print(f"[ENQUIRY FORM] {form_name}: trying {label} click")
            driver.switch_to.window(popup_window)
            driver.execute_script(
                "arguments[0].scrollIntoView({block: 'center'});",
                click_target
            )
            time.sleep(1)

            action()
            time.sleep(4)

            detail_window = find_opened_detail_window(
                driver,
                existing_windows,
                popup_window,
                form_name
            )

            if not detail_window:
                print(f"[ENQUIRY FORM] {form_name}: {label} did not open detail content")
                driver.switch_to.window(popup_window)
                continue

            driver.switch_to.window(detail_window)
            time.sleep(2)
            detail_data = extract_tables_json(driver)
            after_signature = get_results_page_signature(driver)

            if detail_window != popup_window:
                driver.close()
                driver.switch_to.window(popup_window)
            else:
                restore_enquiry_forms_page(driver, popup_window)

            if detail_window == popup_window and after_signature == before_signature:
                print(f"[ENQUIRY FORM] {form_name}: {label} left enquiry table unchanged")
                continue

            if looks_like_parent_enquiry_table(detail_data):
                print(f"[ENQUIRY FORM] {form_name}: ignored parent enquiry table")
                continue

            normalized = normalize_form_detail_data(detail_data)
            if normalized:
                return normalized

        except Exception as e:
            print(f"[ENQUIRY FORM] {form_name}: {label} failed: {e}")
            try:
                if detail_window and detail_window != popup_window:
                    driver.switch_to.window(detail_window)
                    driver.close()
                driver.switch_to.window(popup_window)
            except:
                pass

    return None


def get_enquiry_form_rows(driver):
    rows = []

    for row in driver.find_elements(By.XPATH, "//div[@id='getStageFormDetailsHidden']//tr[.//td]"):
        try:
            cells = row.find_elements(By.XPATH, ".//td")

            if len(cells) < 2:
                continue

            stage = cells[0].text.strip()
            form_name = cells[1].text.strip()
            form_type = cells[2].text.strip() if len(cells) > 2 else ""

            if not form_name:
                continue

            rows.append({
                "row": row,
                "cells": cells,
                "stage": stage,
                "form_name": form_name,
                "form_type": form_type
            })

        except:
            continue

    return rows


def get_view_candidate_from_row(row_info):
    cells = row_info["cells"]
    action_cell = cells[-1]
    candidates = action_cell.find_elements(By.XPATH, ".//*[self::a or self::img or self::button or self::input]")

    if not candidates:
        candidates = [action_cell]

    for candidate in candidates:
        try:
            if candidate.is_displayed():
                return candidate
        except:
            continue

    return None


def should_use_as_eligibility_form(row_info):
    stage = row_info["stage"].lower()
    form_name = row_info["form_name"].lower()
    form_type = row_info["form_type"].lower()

    if "commercial" in stage or "percentage wise rate" in form_name:
        return False

    if "pq" in stage:
        return True

    return form_type == "standard"


def scrape_enquiry_form_details(driver, popup_window, tender_id, limit=None):
    try:
        driver.switch_to.window(popup_window)
    except:
        pass

    details = {}
    rows = get_enquiry_form_rows(driver)

    if not rows:
        return "{}"

    total_rows = len(rows)
    row_limit = min(total_rows, limit) if limit else total_rows

    for row_index in range(row_limit):
        try:
            driver.switch_to.window(popup_window)
        except:
            pass

        rows = get_enquiry_form_rows(driver)
        if row_index >= len(rows):
            break

        row_info = rows[row_index]
        form_name = row_info["form_name"]

        if not form_name or form_name in details:
            continue

        candidate = get_view_candidate_from_row(row_info)
        if not candidate:
            continue

        form_detail = try_open_enquiry_form_candidate(
            driver,
            candidate,
            popup_window,
            form_name
        )

        if form_detail:
            details[form_name] = {
                "stage": row_info["stage"],
                "form_type": row_info["form_type"],
                "tables": form_detail
            }

    if not details:
        print(f"[ENQUIRY FORM] {tender_id}: no row detail popups scraped")

    return json.dumps(details, ensure_ascii=False)


def get_scraped_form_tables(enquiry_form_details, form_name):
    try:
        data = json.loads(enquiry_form_details or "{}")
        record = data.get(form_name)

        if isinstance(record, dict):
            tables = record.get("tables")
            if tables:
                return json.dumps(tables, ensure_ascii=False)

        if isinstance(record, list):
            return json.dumps(record, ensure_ascii=False)

    except:
        pass

    return None


def scrape_eligibility_criteria(driver, popup_window, tender_id):
    try:
        driver.switch_to.window(popup_window)
    except:
        pass

    row_xpath = """
    //div[@id='getStageFormDetailsHidden']//tr[
      contains(
        translate(normalize-space(.),
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        'abcdefghijklmnopqrstuvwxyz'),
        'eligibility criteria'
      )
    ]
    """

    rows = driver.find_elements(By.XPATH, row_xpath)

    for row in rows:
        try:
            if not row.is_displayed():
                continue

            cells = row.find_elements(By.XPATH, ".//td")
            if not cells:
                continue

            action_cell = cells[-1]
            candidates = action_cell.find_elements(By.XPATH, ".//*[self::a or self::img or self::button or self::input]")
            if not candidates:
                candidates = [action_cell]

            candidate = None
            for item in candidates:
                try:
                    if item.is_displayed():
                        candidate = item
                        break
                except:
                    continue

            if not candidate:
                continue

            print("[ELIGIBILITY] Opening Eligibility Criteria view details")
            eligibility_data = try_open_eligibility_candidate(
                driver,
                candidate,
                popup_window,
                "Eligibility Criteria"
            )

            if eligibility_data:
                return eligibility_data

        except Exception as e:
            print(f"[ELIGIBILITY ERROR] Candidate failed: {e}")
            try:
                driver.switch_to.window(popup_window)
            except:
                pass

    print("[ELIGIBILITY] No Eligibility Criteria row found in Enquiry Forms")
    return "No Eligibility Criteria"


# =========================================================
# PHASE 2
# =========================================================

def process_deep_scraping_batch(db_path, pending_tender_ids, worker_label="W1", download_dir=None):

    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] PHASE 2 START [{worker_label}]")

    conn = sqlite3.connect(db_path, timeout=120)
    cursor = conn.cursor()
    cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS};")

    pending_tenders = [(tender_id,) for tender_id in pending_tender_ids]
    retry_counts = {}

    if not pending_tenders:
        print("[SUCCESS] Nothing pending")
        conn.close()
        return

    driver = build_driver(download_dir)

    try:

        if not load_main_table(driver):
            return

        original_window = driver.current_window_handle

        idx = 0

        while idx < len(pending_tenders):

            row = pending_tenders[idx]
            idx += 1

            tender_id = row[0]

            retry_counts.setdefault(tender_id, 0)

            print(f"\n[{worker_label}] [{idx}/{len(pending_tenders)}] {tender_id}")

            try:
                cursor.execute(
                    "SELECT est_value FROM tenders WHERE tender_id=?",
                    (tender_id,)
                )
                tender_row = cursor.fetchone()
                est_value = tender_row[0] if tender_row else ""

                switch_main_frame(driver)

                # search box
                try:
                    search_box = driver.find_element(
                        By.XPATH,
                        "//input[@type='search' or @type='text']"
                    )
                except:
                    load_main_table(driver)

                    search_box = driver.find_element(
                        By.XPATH,
                        "//input[@type='search' or @type='text']"
                    )

                search_box.clear()
                search_box.send_keys(tender_id)

                time.sleep(1)

                try:
                    search_btn = driver.find_element(
                        By.XPATH,
                        "//a[contains(text(),'Search')]"
                    )

                    driver.execute_script(
                        "arguments[0].click();",
                        search_btn
                    )

                except:
                    search_box.send_keys(Keys.RETURN)

                time.sleep(3)

                # open eye popup
                view_btn = driver.find_element(
                    By.XPATH,
                    f"//tr[contains(.,'{tender_id}')]//a"
                )

                existing_windows = set(driver.window_handles)

                driver.execute_script(
                    "arguments[0].click();",
                    view_btn
                )

                time.sleep(4)

                popup_window = None

                new_windows = set(driver.window_handles) - existing_windows

                if new_windows:
                    popup_window = list(new_windows)[0]
                    driver.switch_to.window(popup_window)
                else:
                    popup_window = original_window

                time.sleep(3)

                # =====================================================
                # MAIN DETAILS
                # =====================================================

                tender_details_data = extract_tables_json(driver)
                enquiry_form_details_data = scrape_enquiry_form_details(
                    driver,
                    popup_window,
                    tender_id
                )

                if should_scrape_eligibility_criteria(est_value):
                    eligibility_criteria_data = (
                        get_scraped_form_tables(enquiry_form_details_data, "Eligibility Criteria")
                        or scrape_eligibility_criteria(driver, popup_window, tender_id)
                    )
                else:
                    eligibility_criteria_data = "Not Applicable"

                # =====================================================
                # BOQ EXTRACTION
                # =====================================================

                boq_xpath = """
                //*[self::a or self::img or self::button]
                [
                contains(
                translate(normalize-space(.),
                'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                'abcdefghijklmnopqrstuvwxyz'),
                'boq'
                )
                or
                contains(
                translate(normalize-space(.),
                'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                'abcdefghijklmnopqrstuvwxyz'),
                'item details'
                )
                or
                contains(
                translate(@title,
                'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                'abcdefghijklmnopqrstuvwxyz'),
                'boq'
                )
                or
                contains(
                translate(@title,
                'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                'abcdefghijklmnopqrstuvwxyz'),
                'item details'
                )
                or
                contains(@onclick, 'BOQ')
                or
                contains(
                translate(@onclick,
                'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                'abcdefghijklmnopqrstuvwxyz'),
                'item'
                )
                ]
                """

                boq_data_structure = []

                boq_result = execute_portal_action(
                    driver,
                    boq_xpath,
                    "BOQ"
                )

                if boq_result:

                    try:

                        if boq_result != "same_window":
                            driver.switch_to.window(boq_result)
                            time.sleep(3)

                        # Try to set "Number of Records per Page" to maximum to save pagination time
                        try:
                            dropdown_script = """
                            var select = Array.from(document.querySelectorAll('select')).find(function(el) {
                                var parentText = (el.parentElement ? el.parentElement.innerText || el.parentElement.textContent : '').toLowerCase();
                                return parentText.indexOf('records per page') !== -1 || parentText.indexOf('number of records') !== -1;
                            });
                            if (select && select.options.length > 0) {
                                var currentVal = select.value;
                                var maxVal = select.options[select.options.length - 1].value;
                                if (currentVal !== maxVal) {
                                    select.value = maxVal;
                                    select.dispatchEvent(new Event('change'));
                                    return 'changed';
                                }
                            }
                            return 'no_change';
                            """
                            result = driver.execute_script(dropdown_script)
                            if result == 'changed':
                                print("      -> Set BOQ page size to maximum")
                                time.sleep(5)
                        except Exception as dropdown_error:
                            print(f"      -> Failed to set BOQ page size to maximum: {dropdown_error}")

                        # =================================================
                        # MULTI-PAGE BOQ TRAVERSAL
                        # =================================================

                        while True:

                            current_page_data = extract_tables_json(driver)
                            boq_data_structure.append(current_page_data)

                            next_clicked = False

                            try:
                                next_buttons = driver.find_elements(
                                    By.XPATH,
                                    "//img[contains(@src,'next')] | //a[contains(text(),'Next')]"
                                )

                                for btn in next_buttons:

                                    try:
                                        if not btn.is_displayed():
                                            continue

                                        # detect disabled/dark next button
                                        btn_class = (
                                            btn.get_attribute("class") or ""
                                        ).lower()

                                        btn_style = (
                                            btn.get_attribute("style") or ""
                                        ).lower()

                                        img_src = (
                                            btn.get_attribute("src") or ""
                                        ).lower()

                                        # skip disabled buttons
                                        if (
                                            'disabled' in btn_class
                                            or 'gray' in img_src
                                            or 'grey' in img_src
                                            or 'opacity' in btn_style
                                        ):
                                            continue

                                        print("      -> BOQ next page detected")

                                        driver.execute_script(
                                            "arguments[0].click();",
                                            btn
                                        )

                                        time.sleep(3)

                                        next_clicked = True
                                        break

                                    except:
                                        continue

                            except:
                                pass

                            if not next_clicked:
                                break

                        boq_data_structure = json.dumps(
                            boq_data_structure,
                            ensure_ascii=False
                        )

                        if boq_result != "same_window":
                            driver.close()
                            driver.switch_to.window(popup_window)

                    except Exception as e:
                        print(f"[BOQ ERROR] {e}")

                # =====================================================
                # IMPORTANT PORTAL QUIRK
                # =====================================================

                # After closing BOQ popup,
                # AP portal destroys internal modal state.
                # We MUST reopen the Eye popup again
                # before attempting Tender Documents.

                try:

                    driver.switch_to.window(original_window)
                    switch_main_frame(driver)

                    search_box = driver.find_element(
                        By.XPATH,
                        "//input[@type='search' or @type='text']"
                    )

                    search_box.clear()
                    search_box.send_keys(tender_id)

                    time.sleep(1)

                    try:
                        search_btn = driver.find_element(
                            By.XPATH,
                            "//a[contains(text(),'Search')]"
                        )

                        driver.execute_script(
                            "arguments[0].click();",
                            search_btn
                        )

                    except:
                        search_box.send_keys(Keys.RETURN)

                    time.sleep(3)

                    view_btn = driver.find_element(
                        By.XPATH,
                        f"//tr[contains(.,'{tender_id}')]//a"
                    )

                    existing_windows = set(driver.window_handles)

                    driver.execute_script(
                        "arguments[0].click();",
                        view_btn
                    )

                    time.sleep(4)

                    new_windows = set(driver.window_handles) - existing_windows

                    if new_windows:
                        popup_window = list(new_windows)[0]
                        driver.switch_to.window(popup_window)

                except Exception as reopen_error:
                    print(f"[REOPEN ERROR] {reopen_error}")

                # =====================================================
                # DOCUMENT EXTRACTION
                # =====================================================

                doc_xpath = """
                //*[self::a or self::img or self::button]
                [
                contains(
                translate(normalize-space(.),
                'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                'abcdefghijklmnopqrstuvwxyz'),
                'document'
                )
                or
                contains(
                translate(@title,
                'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                'abcdefghijklmnopqrstuvwxyz'),
                'document'
                )
                or
                contains(
                translate(@title,
                'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                'abcdefghijklmnopqrstuvwxyz'),
                'zip'
                )
                or
                contains(@onclick, 'Document')
                ]
                """

                doc_data_structure = "Documents Not Available"
                document_base_url = None
                browser_document_records = []

                try:
                    driver.switch_to.window(popup_window)
                except:
                    pass

                doc_result = execute_portal_action(
                    driver,
                    doc_xpath,
                    "DOCUMENTS"
                )

                if doc_result:

                    try:

                        if doc_result != "same_window":
                            driver.switch_to.window(doc_result)
                            time.sleep(3)

                        document_base_url = driver.current_url
                        doc_data_structure = extract_tables_json(driver)
                        browser_document_records = download_document_files_with_browser(
                            driver,
                            download_dir,
                            tender_id
                        )

                        if doc_result != "same_window":
                            driver.close()
                            driver.switch_to.window(popup_window)

                    except Exception as e:
                        print(f"[DOC ERROR] {e}")

                direct_document_files_data = download_document_files(
                    driver,
                    doc_data_structure,
                    document_base_url
                )
                document_files_data = merge_document_file_records(
                    browser_document_records,
                    direct_document_files_data
                )

                if isinstance(boq_data_structure, list):
                    boq_data_structure = json.dumps(boq_data_structure, ensure_ascii=False)
                if isinstance(doc_data_structure, list):
                    doc_data_structure = json.dumps(doc_data_structure, ensure_ascii=False)

                # =====================================================
                # SAVE TO DB
                # =====================================================

                execute_db_write(
                    conn,
                    cursor,
                    """
                    UPDATE tenders
                    SET
                        tender_details=?,
                        enquiry_form_details=?,
                        eligibility_criteria=?,
                        boq_link=?,
                        document_link=?,
                        document_files=?
                    WHERE tender_id=?
                    """,
                    (
                        tender_details_data,
                        enquiry_form_details_data,
                        eligibility_criteria_data,
                        boq_data_structure,
                        doc_data_structure,
                        document_files_data,
                        tender_id
                    ),
                    worker_label
                )

                print("[SUCCESS] Saved all details")

                # cleanup popup
                try:
                    if popup_window != original_window:
                        driver.switch_to.window(popup_window)
                        driver.close()
                        driver.switch_to.window(original_window)
                except:
                    pass

            except Exception as e:

                print(f"[ERROR] {tender_id}: {e}")

                # emergency cleanup
                try:
                    for w in driver.window_handles:
                        if w != original_window:
                            driver.switch_to.window(w)
                            driver.close()

                    driver.switch_to.window(original_window)

                except:
                    pass

                retry_counts[tender_id] += 1

                if retry_counts[tender_id] < MAX_TENDER_RETRIES:
                    print(
                        f"[RETRY] {tender_id}: waiting {RETRY_WAIT_SECONDS}s, "
                        "reopening browser, then repeating tender"
                    )

                    time.sleep(RETRY_WAIT_SECONDS)

                    try:
                        driver.quit()
                    except:
                        pass

                    driver = build_driver(download_dir)

                    if not load_main_table(driver):
                        raise RuntimeError("Could not reload main table after retry")

                    original_window = driver.current_window_handle
                    pending_tenders.append(row)

                else:
                    execute_db_write(
                        conn,
                        cursor,
                        """
                        UPDATE tenders
                        SET tender_details='Data Not Found'
                        WHERE tender_id=?
                        """,
                        (tender_id,),
                        worker_label
                    )

    except Exception:
        traceback.print_exc()

    finally:
        conn.close()

        try:
            driver.quit()
        except:
            pass


def chunk_list(values, chunk_count):
    return [
        values[index::chunk_count]
        for index in range(chunk_count)
        if values[index::chunk_count]
    ]


def process_deep_scraping(db_path, worker_count=DEEP_SCRAPE_WORKERS):
    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] PHASE 2 QUEUE START")

    max_loops = 5
    loop_count = 0
    previous_pending_count = 999999

    while loop_count < max_loops:
        loop_count += 1

        conn = sqlite3.connect(db_path, timeout=120)
        cursor = conn.cursor()
        cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS};")

        cursor.execute(
            """
            SELECT tender_id, tender_category, est_value
            FROM tenders
            WHERE COALESCE(is_active, 1)=1
              AND (
                  tender_details IS NULL
                  OR tender_details=''
                  OR tender_details='Pending Deep Extraction'
                  OR tender_details='Data Not Found'
                  OR enquiry_form_details IS NULL
                  OR enquiry_form_details=''
                  OR boq_link IS NULL
                  OR boq_link=''
                  OR document_link IS NULL
                  OR document_link=''
                  OR eligibility_criteria IS NULL
                  OR eligibility_criteria=''
                  OR eligibility_criteria='Pending Eligibility Extraction'
              )
            ORDER BY scraped_at DESC
            """
        )
        primary_rows = cursor.fetchall()

        cursor.execute(
            """
            SELECT tender_id, tender_category, est_value
            FROM tenders
            WHERE COALESCE(is_active, 1)=1
              AND document_files LIKE '%"error"%'
            ORDER BY scraped_at DESC
            """
        )
        failed_document_rows = cursor.fetchall()
        conn.close()

        if SCRAPER_TEST_LIMIT > 0:
            primary_rows = [
                row for row in primary_rows
                if is_works_over_50_lakhs(row[1], row[2])
            ]
            failed_document_rows = [
                row for row in failed_document_rows
                if is_works_over_50_lakhs(row[1], row[2])
            ]

        primary_tender_ids = [row[0] for row in primary_rows]
        failed_document_ids = [row[0] for row in failed_document_rows]

        pending_tender_ids = []
        seen = set()

        for tender_id in primary_tender_ids + failed_document_ids:
            if tender_id not in seen:
                seen.add(tender_id)
                pending_tender_ids.append(tender_id)

        if not pending_tender_ids:
            print(f"[SUCCESS] All pending tenders fully scraped after loop {loop_count - 1}!")
            break

        if SCRAPER_TEST_LIMIT > 0:
            pending_tender_ids = pending_tender_ids[:SCRAPER_TEST_LIMIT]

        current_pending_count = len(pending_tender_ids)
        print(f"\n[LOOP {loop_count}/{max_loops}] Remaining pending tenders to scrape: {current_pending_count}")

        # If we didn't make any progress in the last loop run, stop to prevent infinite loops on dead links
        if current_pending_count >= previous_pending_count and loop_count > 2:
            print(f"[SYSTEM] No progress made in the last run (still {current_pending_count} pending). Stopping loop to prevent infinite retry of dead links.")
            break

        previous_pending_count = current_pending_count

        current_workers = max(1, min(worker_count, len(pending_tender_ids)))

        if current_workers == 1:
            download_dir = os.path.join(os.path.dirname(db_path), "downloads", "W1")
            process_deep_scraping_batch(db_path, pending_tender_ids, "W1", download_dir)
        else:
            print(f"[SYSTEM] Processing {len(pending_tender_ids)} tenders with {current_workers} workers")
            processes = []

            for idx, chunk in enumerate(chunk_list(pending_tender_ids, current_workers), start=1):
                download_dir = os.path.join(os.path.dirname(db_path), "downloads", f"W{idx}")
                process = multiprocessing.Process(
                    target=process_deep_scraping_batch,
                    args=(db_path, chunk, f"W{idx}", download_dir)
                )
                process.start()
                processes.append(process)

                if DB_WORKER_START_GAP_SECONDS:
                    print(f"[SYSTEM] Waiting {DB_WORKER_START_GAP_SECONDS:.1f}s before starting next worker")
                    time.sleep(DB_WORKER_START_GAP_SECONDS)

            for process in processes:
                process.join()

                if process.exitcode != 0:
                    print(f"[WARNING] Worker exited with code {process.exitcode}")

        # Give the portal firewall a 5-second breathing room before retrying remaining failed ones
        if len(pending_tender_ids) > 0:
            time.sleep(5)



def cleanup_completed_tenders(db_path):
    print("\n[SYSTEM] Cleaning up completed / expired tenders and associated PDF files...")
    
    conn = sqlite3.connect(db_path, timeout=120)
    cursor = conn.cursor()
    cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS};")
    
    try:
        cursor.execute("SELECT tender_id, closing_date, is_active, document_files FROM tenders")
        rows = cursor.fetchall()
    except Exception as e:
        print(f"[ERROR] Failed to query tenders for cleanup: {e}")
        conn.close()
        return

    completed_ids = []
    files_to_delete = []

    now = datetime.now()

    for row in rows:
        tender_id, closing_date_str, is_active, doc_files_json = row
        is_completed = False
        
        # 1. Check if inactive
        if is_active == 0:
            is_completed = True
        
        # 2. Check if closing date is past
        if closing_date_str:
            try:
                closing_dt = datetime.strptime(closing_date_str.strip(), '%d/%m/%Y %I:%M %p')
                if closing_dt < now:
                    is_completed = True
            except Exception:
                pass
                
        if is_completed:
            completed_ids.append(tender_id)
            if doc_files_json:
                try:
                    doc_files = json.loads(doc_files_json)
                    for file_rec in doc_files:
                        if isinstance(file_rec, dict) and file_rec.get("filename"):
                            files_to_delete.append(file_rec["filename"])
                except Exception:
                    pass

    if completed_ids:
        print(f"[SYSTEM] Found {len(completed_ids)} completed/expired tenders to delete.")
        
        # Delete local files in the downloads directory
        downloads_base = os.path.join(os.path.dirname(db_path), "downloads")
        deleted_files_count = 0
        if os.path.isdir(downloads_base) and files_to_delete:
            for root, dirs, files in os.walk(downloads_base):
                for file in files:
                    if file in files_to_delete:
                        file_path = os.path.join(root, file)
                        try:
                            os.remove(file_path)
                            deleted_files_count += 1
                        except Exception as fe:
                            print(f"[WARNING] Failed to delete local file {file_path}: {fe}")
        
        print(f"[SYSTEM] Deleted {deleted_files_count} local downloaded document files.")

        # Delete from database in chunks
        chunk_size = 500
        for i in range(0, len(completed_ids), chunk_size):
            chunk = completed_ids[i:i + chunk_size]
            placeholders = ",".join("?" for _ in chunk)
            try:
                cursor.execute(
                    f"DELETE FROM tenders WHERE tender_id IN ({placeholders})",
                    chunk
                )
            except Exception as e:
                print(f"[ERROR] Failed to delete tenders chunk from DB: {e}")
                
        conn.commit()
        print(f"[SYSTEM] Deleted {len(completed_ids)} tender records from database.")
        
        # Reclaim disk space
        print("[SYSTEM] Running VACUUM on database to reclaim disk space...")
        try:
            cursor.execute("VACUUM")
            print("[SYSTEM] VACUUM complete. Database size optimized.")
        except Exception as ve:
            print(f"[WARNING] VACUUM failed: {ve}")
            
    else:
        print("[SYSTEM] No completed or expired tenders found to clean up.")

    conn.close()


def run_scraper_cycle():
    db, db_path = setup_database()
    db.close()

    print("\n=== AP eProcurement Scraper Cycle ===")

    # Check if database has existing tenders to decide between full or incremental scrape
    conn = sqlite3.connect(db_path, timeout=120)
    cursor = conn.cursor()
    cursor.execute(f"PRAGMA busy_timeout={SQLITE_BUSY_TIMEOUT_MS};")
    try:
        cursor.execute("SELECT COUNT(*) FROM tenders")
        tender_count = cursor.fetchone()[0]
    except Exception:
        tender_count = 0
    finally:
        conn.close()

    if tender_count == 0:
        print("[SYSTEM] Database is empty. Scraping all pages for initial data load...")
        max_pages = None
    else:
        # Enforce MAX_PAGES (default to 5 pages if not specified)
        max_pages = MAX_PAGES if MAX_PAGES > 0 else 5
        print(f"[SYSTEM] Database has {tender_count} records. Scraping first {max_pages} pages for fast update...")

    # phase 1
    scraped = scrape_tenders(max_pages=max_pages)

    if scraped:
        sync_phase1_tenders(db_path, scraped)
    else:
        print("[WARNING] Phase 1 returned no tenders. Skipping removal sync to avoid false removals.")

    # phase 2
    process_deep_scraping(db_path)

    # cleanup phase
    cleanup_completed_tenders(db_path)

    print("\n[SYSTEM] CYCLE COMPLETE")


# =========================================================
# MAIN
# =========================================================

if __name__ == '__main__':

    multiprocessing.freeze_support()

    print("\n=== AP eProcurement Scraper ===")

    while True:
        cycle_started_at = datetime.now()

        try:
            run_scraper_cycle()
        except Exception:
            traceback.print_exc()

        if RUN_SCRAPER_ONCE:
            break

        elapsed = (datetime.now() - cycle_started_at).total_seconds()
        sleep_for = max(0, SCRAPER_INTERVAL_SECONDS - elapsed)

        print(
            f"[SYSTEM] Sleeping {int(sleep_for)} seconds before next cycle "
            f"(interval={SCRAPER_INTERVAL_SECONDS}s)"
        )

        time.sleep(sleep_for)
