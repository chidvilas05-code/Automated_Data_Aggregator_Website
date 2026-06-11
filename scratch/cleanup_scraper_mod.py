import os

scraper_path = 'backend/scraper.py'

with open(scraper_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Normalize line endings
content_norm = content.replace('\r\n', '\n')

# 1. Replace SCRAPER_INTERVAL_SECONDS
target_interval = 'SCRAPER_INTERVAL_SECONDS = int(os.environ.get("SCRAPER_INTERVAL_SECONDS", "3600"))'
replacement_interval = 'SCRAPER_INTERVAL_SECONDS = int(os.environ.get("SCRAPER_INTERVAL_SECONDS", "18000"))'

if target_interval in content_norm:
    content_norm = content_norm.replace(target_interval, replacement_interval)
    print("Interval updated successfully.")
else:
    print("Error: Target interval not found!")
    exit(1)

# 2. Define cleanup_completed_tenders and update run_scraper_cycle
target_cycle = """def run_scraper_cycle():
    db, db_path = setup_database()
    db.close()

    print("\\n=== AP eProcurement Scraper Cycle ===")

    # phase 1
    scraped = scrape_tenders()

    if scraped:
        sync_phase1_tenders(db_path, scraped)
    else:
        print("[WARNING] Phase 1 returned no tenders. Skipping removal sync to avoid false removals.")

    # phase 2
    process_deep_scraping(db_path)

    print("\\n[SYSTEM] CYCLE COMPLETE")"""

replacement_cycle = """def cleanup_completed_tenders(db_path):
    print("\\n[SYSTEM] Cleaning up completed / expired tenders and associated PDF files...")
    
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

    print("\\n=== AP eProcurement Scraper Cycle ===")

    # phase 1
    scraped = scrape_tenders()

    if scraped:
        sync_phase1_tenders(db_path, scraped)
    else:
        print("[WARNING] Phase 1 returned no tenders. Skipping removal sync to avoid false removals.")

    # phase 2
    process_deep_scraping(db_path)

    # cleanup phase
    cleanup_completed_tenders(db_path)

    print("\\n[SYSTEM] CYCLE COMPLETE")"""

if target_cycle in content_norm:
    content_norm = content_norm.replace(target_cycle, replacement_cycle)
    print("Scraper cycle and cleanup logic inserted successfully.")
else:
    print("Error: Target cycle block not found!")
    exit(1)

with open(scraper_path, 'w', encoding='utf-8') as f:
    f.write(content_norm)

print("Scraper modifications complete!")
