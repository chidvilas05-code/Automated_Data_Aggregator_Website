#!/bin/bash
# Script to automate setting up the Automated Tender Aggregator Scraper & API on Oracle Cloud Ubuntu VM

echo "==========================================="
echo "Starting OCI VM Setup..."
echo "==========================================="

# Exit immediately if a command exits with a non-zero status
set -e

# 1. Update system package repository
echo "[1/5] Updating system packages..."
sudo apt update -y

# 2. Install dependencies (Python, Git, Pip, Virtualenv, Chromium, Nginx)
echo "[2/5] Installing Python, Git, Chromium, and Nginx..."
sudo apt install -y python3-pip python3-venv git chromium-browser chromium-chromedriver nginx

# 3. Create Project Directory
echo "[3/5] Setting up project directory..."
mkdir -p ~/tender-aggregator
cd ~/tender-aggregator

# 4. Create Python Virtual Environment and install packages
echo "[4/5] Setting up Python Virtual Environment..."
python3 -m venv .venv
source .venv/bin/activate

# Create a requirements.txt with essential packages
cat <<EOT > requirements.txt
fastapi
uvicorn
requests
selenium
EOT

pip install -r requirements.txt

# 5. Create Systemd Service for FastAPI API Server
echo "[5/5] Creating systemd service for FastAPI API..."
sudo tee /etc/systemd/system/tender-api.service > /dev/null <<EOT
[Unit]
Description=Tender Aggregator FastAPI Service
After=network.target

[Service]
User=ubuntu
WorkingDirectory=/home/ubuntu/tender-aggregator/backend
ExecStart=/home/ubuntu/tender-aggregator/backend/.venv/bin/uvicorn api:app --host 0.0.0.0 --port 8000
Restart=always

[Install]
WantedBy=multi-user.target
EOT

# Reload and start service
sudo systemctl daemon-reload
# We don't start it immediately since the user needs to upload their backend folder code first
echo ""
echo "=========================================================="
echo "Installation complete!"
echo "=========================================================="
echo "Next Steps to launch:"
echo "1. Upload your 'backend' folder code from your local machine to '/home/ubuntu/tender-aggregator/backend' on the VM."
echo "2. Start the FastAPI API service:"
echo "   sudo systemctl enable tender-api.service"
echo "   sudo systemctl start tender-api.service"
echo "3. Schedule the scraper to run every 5 hours:"
echo "   CRON_JOB=\"0 */5 * * * /home/ubuntu/tender-aggregator/backend/.venv/bin/python /home/ubuntu/tender-aggregator/backend/scraper.py >> /home/ubuntu/tender-aggregator/backend/scraper.log 2>&1\""
echo "   (crontab -l 2>/dev/null; echo \"\$CRON_JOB\") | crontab -"
echo "=========================================================="
