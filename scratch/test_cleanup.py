import sys
import os
from datetime import datetime

# Add backend directory to system path
sys.path.append(os.path.abspath('backend'))
from scraper import cleanup_completed_tenders

db_path = 'backend/tenders.db'

print(f"[{datetime.now().strftime('%H:%M:%S')}] Starting database cleanup test...")
initial_size = os.path.getsize(db_path) / (1024 * 1024 * 1024)
print(f"Initial Database Size: {initial_size:.3f} GB")

cleanup_completed_tenders(db_path)

final_size = os.path.getsize(db_path) / (1024 * 1024 * 1024)
print(f"Final Database Size: {final_size:.3f} GB")
print(f"Reclaimed Space: {(initial_size - final_size) * 1024:.2f} MB")
