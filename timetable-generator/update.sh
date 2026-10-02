#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOCAL_MODE=false
if [ "${1:-}" = "--local" ]; then
  LOCAL_MODE=true
fi

# ─── Dependency checks & installs ───

# Node.js 22
if ! command -v node &>/dev/null || [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 22 ]]; then
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

# wrangler CLI (only needed for deploy)
if [ "$LOCAL_MODE" = false ]; then
  if ! npx wrangler --version &>/dev/null; then
    echo "wrangler not found. Installing…"
    npm install -g wrangler
  fi
  echo "wrangler: $(npx wrangler --version 2>/dev/null | head -1)"
fi

# Static map files — extract from LFS zip if budapest/ is missing key dirs
if [ ! -d "budapest/0" ] || [ ! -d "budapest/1" ]; then
  echo "Static map files missing. Extracting from LFS zip…"
  if command -v git-lfs &>/dev/null; then
    git lfs install
    git lfs pull
  fi
  if [ -f "budapest_static_map_files.zip" ]; then
    unzip -o budapest_static_map_files.zip -d budapest/
  else
    echo "WARNING: No LFS zip found at budapest_static_map_files.zip. Static map files must be added manually."
  fi
fi

# ─── Validate Cloudflare access ───

if [ "$LOCAL_MODE" = false ]; then
  echo "Checking Cloudflare API access…"
  if ! npx wrangler whoami &>/dev/null 2>&1; then
    echo "ERROR: wrangler whoami failed. CLOUDFLARE_API_TOKEN is missing or invalid."
    echo "Set a valid token: export CLOUDFLARE_API_TOKEN=your_token"
    exit 1
  fi
  echo "Cloudflare access OK."
fi

# ─── Generate timetables ───

echo "Downloading GTFS data…"
wget -q --show-progress -O budapest_gtfs.zip https://bkk.hu/gtfs/budapest_gtfs.zip

echo "Generating timetable for the next 7 days…"
node --max-old-space-size=8100 genDays.js --days=7

echo "Zipping timetable files…"
mkdir -p budapest/ziptimetable
cd budapest/timetable
find . -type f -exec zip --compression-method deflate -9 -D '../ziptimetable/{}.zip' '{}' \;
cd "$SCRIPT_DIR"
rm -rf budapest/timetable
mv budapest/ziptimetable budapest/timetable

# ─── Deploy ───

if [ "$LOCAL_MODE" = true ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  echo "Local mode: copying generated files to repo for local serving…"

  # Copy timetable zips to repo's budapest/timetable/ (served by local HTTP)
  mkdir -p "$REPO_ROOT/budapest/timetable"
  cp budapest/timetable/*.zip "$REPO_ROOT/budapest/timetable/"

  # Copy map tiles to repo's budapest/
  for d in budapest/*/; do
    dir_name=$(basename "$d")
    if [[ "$dir_name" =~ ^[0-9]+$ ]]; then
      mkdir -p "$REPO_ROOT/budapest/$dir_name"
      cp -r "$d"* "$REPO_ROOT/budapest/$dir_name/" 2>/dev/null || true
    fi
  done

  # Copy GTFS split files if present
  for f in budapest_gtfs.zip*; do
    if [ -f "$f" ]; then
      cp "$f" "$REPO_ROOT/budapest/"
    fi
  done

  # Create local.js to override URLs for local dev
  cat > "$REPO_ROOT/scripts/local.js" << 'LOCALJS'
// Override URLs for local dev — use relative paths so hostname/port match the page
var timetable_url = '/budapest/timetable/';
var gtfs_urls = [
  '/budapest/budapest_gtfs.zipaa',
  '/budapest/budapest_gtfs.zipab',
  '/budapest/budapest_gtfs.zipac'
];

// Override map tile URL for main page (maplibre requires absolute URLs)
if (typeof style !== 'undefined' && style.sources && style.sources.openmaptiles) {
  style.sources.openmaptiles.tiles = [window.location.origin + '/budapest/{z}/{x}/{y}.pbf'];
}
LOCALJS

  echo "Done. Serve with: cd $REPO_ROOT && python3 -m http.server 8080"
  echo "Then open http://localhost:8080/index.html"
else
  echo "Deploying to Cloudflare Pages…"
  npx wrangler pages deploy budapest --project-name bprp --branch production
fi

echo "Done."
