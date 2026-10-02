#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── Dependency checks & installs ───

# Node.js 22
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -dv)" -lt 22 ]]; then
  echo "Node.js 22+ not found. Installing via nvm…"
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
fi
echo "Node: $(node --version)"

# wrangler CLI
if ! command -v wrangler &>/dev/null; then
  echo "wrangler not found. Installing…"
  npm install -g wrangler
fi
echo "wrangler: $(wrangler --version 2>/dev/null | head -1)"

# Project dependencies
if [ ! -d "node_modules" ]; then
  echo "Installing project dependencies…"
  npm install
fi

# Static map files — download from LFS zip if budapest/ is missing key dirs
if [ ! -d "budapest/0" ] || [ ! -d "budapest/1" ]; then
  echo "Static map files missing. Downloading from LFS zip…"
  if command -v git-lfs &>/dev/null; then
    git lfs install
    git lfs pull
  fi
  if [ -f "budapest/static_map_files.zip" ]; then
    unzip -o budapest/static_map_files.zip -d budapest/
    rm budapest/static_map_files.zip
  else
    echo "WARNING: No LFS zip found at budapest/static_map_files.zip. Static map files must be added manually."
  fi
fi

# ─── Validate Cloudflare access ───

echo "Checking Cloudflare API access…"
if ! wrangler whoami &>/dev/null 2>&1; then
  echo "ERROR: wrangler whoami failed. CLOUDFLARE_API_TOKEN is missing or invalid."
  echo "Set a valid token: export CLOUDFLARE_API_TOKEN=your_token"
  exit 1
fi
echo "Cloudflare access OK."

# ─── Generate timetables ───

echo "Downloading GTFS data…"
wget -q --show-progress -O budapest_gtfs.zip https://bkk.hu/gtfs/budapest_gtfs.zip

echo "Generating timetable for the next 7 days…"
node --max-old-space-size=8100 genDays.js --days=7

echo "Zipping timetable files…"
cd budapest/timetable
find . -type f -exec zip --compression-method deflate -9 -D '../ziptimetable/{}.zip' '{}' \;
cd "$SCRIPT_DIR"
mv budapest/timetable/ziptimetable budapest/ziptimetable
rm -rf budapest/timetable
mv budapest/ziptimetable budapest/timetable

# ─── Deploy to Cloudflare Pages ───

echo "Deploying to Cloudflare Pages…"
npx wrangler pages deploy budapest --project-name bprp

echo "Done."
