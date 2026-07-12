#!/usr/bin/env bash
# Deploy PDF Worker to data@192.168.2.11
set -euo pipefail

REMOTE_HOST="data@192.168.2.11"
REMOTE_DIR="~/knowledge-worker"

echo "=== Deploying PDF Worker to $REMOTE_HOST ==="

# Copy worker files
scp scripts/pdf-worker/app.py scripts/pdf-worker/requirements.txt "$REMOTE_HOST:$REMOTE_DIR/"

# Setup on remote
ssh "$REMOTE_HOST" bash -s << 'REMOTESCRIPT'
set -euo pipefail
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export PATH="$HOME/.local/bin:$PATH"

cd ~/knowledge-worker

# Create venv if not exists
if [ ! -f .venv/bin/activate ]; then
  uv venv --python 3.14
fi

source .venv/bin/activate

# Install/update Python deps
uv pip install -r requirements.txt

# Create cache dir
mkdir -p ~/knowledge-cache

# Ensure start script
cat > start.sh << 'SHEOF'
#!/bin/bash
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export PATH="$HOME/.local/bin:$HOME/knowledge-worker/.venv/bin:$PATH"
export MAX_CONCURRENT=2
cd ~/knowledge-worker
source .venv/bin/activate
exec uvicorn app:app --host 0.0.0.0 --port 8000
SHEOF
chmod +x start.sh

# Kill existing process
pkill -f "uvicorn app:app" 2>/dev/null || true

# Start
nohup ./start.sh > worker.log 2>&1 &
echo "Worker started on port 8000 (PID: $!)"

REMOTESCRIPT

echo "=== Deployment complete ==="
