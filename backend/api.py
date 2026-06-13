from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List
from urllib.parse import unquote, urlparse
from io import BytesIO
import base64
import json
import os
import re
import requests
import sqlite3

app = FastAPI(title="Tender Aggregator API")

# --- CORS Configuration ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Pydantic Models for Auth ---
class UserSignup(BaseModel):
    username: str
    password: str
    phone: str
    districts: List[str]


class UserLogin(BaseModel):
    username: str
    password: str


class UserForgotVerify(BaseModel):
    username: str
    phone: str


class UserForgotReset(BaseModel):
    username: str
    newPassword: str


# --- Database Helper ---
def get_db_connection():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    db_path = os.path.join(script_dir, "tenders.db")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


# --- Initialize Users Table ---
def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT,
            phone TEXT,
            districts TEXT
        )
        """
    )

    # Check if phone column needs to be added (for backward compatibility if table existed)
    cursor.execute("PRAGMA table_info(users)")
    user_columns = {row["name"] for row in cursor.fetchall()}
    if user_columns and "phone" not in user_columns:
        cursor.execute("ALTER TABLE users ADD COLUMN phone TEXT")

    cursor.execute("PRAGMA table_info(tenders)")
    tender_columns = {row["name"] for row in cursor.fetchall()}

    if tender_columns and "document_files" not in tender_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN document_files TEXT")

    if tender_columns and "eligibility_criteria" not in tender_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN eligibility_criteria TEXT")

    if tender_columns and "enquiry_form_details" not in tender_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN enquiry_form_details TEXT")

    if tender_columns and "is_active" not in tender_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN is_active INTEGER DEFAULT 1")

    if tender_columns and "removed_at" not in tender_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN removed_at TIMESTAMP")

    if tender_columns and "last_seen_at" not in tender_columns:
        cursor.execute("ALTER TABLE tenders ADD COLUMN last_seen_at TIMESTAMP")

    conn.commit()
    conn.close()


init_db()


# --- API Endpoints ---
@app.get("/")
def read_root():
    return {"message": "Welcome to the Tender Aggregator API! Go to /api/tenders to see the data."}


@app.post("/api/signup")
def signup(user: UserSignup):
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT username FROM users WHERE username = ?", (user.username,))
    if cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=400, detail="Username already exists")

    districts_json = json.dumps(user.districts)
    cursor.execute(
        "INSERT INTO users (username, password, phone, districts) VALUES (?, ?, ?, ?)",
        (user.username, user.password, user.phone, districts_json),
    )
    conn.commit()
    conn.close()
    return {"status": "success", "message": "User created successfully"}


@app.post("/api/login")
def login(user: UserLogin):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM users WHERE username = ? AND password = ?",
        (user.username, user.password),
    )
    row = cursor.fetchone()
    conn.close()

    if row:
        return {
            "status": "success",
            "data": {
                "username": row["username"],
                "districts": json.loads(row["districts"]),
            },
        }
    raise HTTPException(status_code=401, detail="Invalid username or password")


@app.post("/api/forgot/verify")
def forgot_verify(req: UserForgotVerify):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT phone FROM users WHERE username = ?", (req.username,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Username does not exist")

    if row["phone"] != req.phone:
        raise HTTPException(status_code=400, detail="Phone number does not match this username")

    return {"status": "success", "message": "Verification successful"}


@app.post("/api/forgot/reset")
def forgot_reset(req: UserForgotReset):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT username FROM users WHERE username = ?", (req.username,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Username does not exist")

    cursor.execute(
        "UPDATE users SET password = ? WHERE username = ?",
        (req.newPassword, req.username),
    )
    conn.commit()
    conn.close()
    return {"status": "success", "message": "Password reset successfully"}



@app.get("/api/tenders")
def get_tenders():
    """Fetch all scraped tenders from the SQLite database, excluding heavy deep-data columns."""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute(
            """
            SELECT department, tender_id, tender_notice_number, tender_category,
                   title, est_value, start_date, closing_date, scraped_at,
                   is_active, removed_at, last_seen_at
            FROM tenders
            WHERE COALESCE(is_active, 1)=1
            ORDER BY scraped_at DESC
            """
        )
        rows = cursor.fetchall()
        tenders = [dict(row) for row in rows]
        conn.close()

        return {
            "status": "success",
            "count": len(tenders),
            "data": tenders,
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/tenders/{tender_id}")
def get_tender_details(tender_id: str):
    """Fetch complete deep data (BOQ, Docs, Details) for a specific tender."""
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM tenders WHERE tender_id = ?", (tender_id,))
        row = cursor.fetchone()
        conn.close()

        if row:
            data = dict(row)
            document_files = []

            if data.get("document_files"):
                try:
                    stored_files = json.loads(data["document_files"])
                    document_files = [
                        {
                            "index": idx,
                            "filename": item.get("filename", f"document-{idx + 1}"),
                            "content_type": item.get("content_type", "application/octet-stream"),
                            "size": item.get("size", 0),
                            "source_url": item.get("source_url"),
                            "error": item.get("error"),
                        }
                        for idx, item in enumerate(stored_files)
                    ]
                except Exception:
                    document_files = []

            data["document_files"] = document_files

            return {
                "status": "success",
                "data": data,
            }
        raise HTTPException(status_code=404, detail="Tender not found")
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/tenders/{tender_id}/documents/{document_index}")
def get_stored_tender_document(tender_id: str, document_index: int):
    """Download a tender document that was already saved in SQLite by the scraper."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT document_files FROM tenders WHERE tender_id = ?", (tender_id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="Tender not found")

    try:
        stored_files = json.loads(row["document_files"] or "[]")
        file_record = stored_files[document_index]
    except Exception:
        raise HTTPException(status_code=404, detail="Document not found")

    if file_record.get("error") or not file_record.get("data_base64"):
        raise HTTPException(status_code=404, detail=file_record.get("error", "Document file not available"))

    try:
        content = base64.b64decode(file_record["data_base64"])
    except Exception:
        raise HTTPException(status_code=500, detail="Stored document data is invalid")

    filename = file_record.get("filename") or f"{tender_id}-document-{document_index + 1}"
    content_type = file_record.get("content_type") or "application/octet-stream"

    return StreamingResponse(
        BytesIO(content),
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@app.get("/api/download")
def download_file(url: str):
    """Stream a portal document through the backend so the frontend can offer a download."""
    try:
        response = requests.get(
            url,
            stream=True,
            timeout=60,
            allow_redirects=True,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                "Accept": "application/octet-stream,application/zip,application/pdf,*/*",
                "Referer": "https://tender.apeprocurement.gov.in/",
            },
        )
        response.raise_for_status()

        content_type = response.headers.get("Content-Type", "application/octet-stream")
        if "text/html" in content_type.lower():
            raise HTTPException(
                status_code=502,
                detail="Portal returned an HTML page instead of a document. Re-run the scraper so the document is saved in the database with an authenticated session.",
            )

        parsed_url = urlparse(url)
        disposition = response.headers.get("Content-Disposition", "")
        filename_match = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', disposition, re.IGNORECASE)
        filename = (
            unquote(filename_match.group(1).strip())
            if filename_match
            else unquote(os.path.basename(parsed_url.path)) or "tender-document"
        )

        return StreamingResponse(
            response.iter_content(chunk_size=8192),
            media_type=content_type,
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
            },
        )
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Unable to download document: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
