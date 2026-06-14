#!/bin/bash
set -e

echo "[DEPLOY] Checking current directory..."
if [ ! -f "backend/requirements.txt" ] || [ ! -f "backend/scraper.py" ]; then
    echo "[ERROR] You are not in the root directory of the Automated_Data_Aggregator_Website project!"
    echo "Please cd to the project root and try again."
    exit 1
fi

echo "[DEPLOY] Pulling latest changes from Git..."
git pull origin main

echo "[DEPLOY] Activating virtual environment..."
if [ -d "backend/.venv" ]; then
    source backend/.venv/bin/activate
elif [ -d "venv" ]; then
    source venv/bin/activate
else
    echo "[DEPLOY] Creating virtual environment backend/.venv..."
    python3 -m venv backend/.venv
    source backend/.venv/bin/activate
fi

echo "[DEPLOY] Upgrading pip and installing dependencies..."
pip install --upgrade pip
pip install -r backend/requirements.txt

echo "[DEPLOY] Installing Playwright Chromium browser and system libraries..."
playwright install chromium
sudo playwright install-deps

# Service restart
echo "[DEPLOY] Attempting to restart scraper services..."
SERVICES=("ap-scraper.service" "automated-data-aggregator.service" "scraper.service" "aggregator.service")
restarted=false

for svc in "${SERVICES[@]}"; do
    if systemctl list-units --type=service | grep -q "$svc"; then
        echo "[DEPLOY] Found systemd service: $svc. Restarting..."
        sudo systemctl restart "$svc"
        restarted=true
    fi
done

if [ "$restarted" = true ]; then
    echo "[DEPLOY] Service(s) restarted successfully!"
else
    echo "[DEPLOY] No active systemd service found matching scraper names. Please restart your scraper service/process manually."
fi

echo "[DEPLOY] Deployment complete!"
