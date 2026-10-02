#!/bin/bash
# CI test runner: starts geckodriver locally and runs remote-browser.js
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

# Install test dependencies
cd "$SCRIPT_DIR" && npm install --silent && cd "$REPO_ROOT"

# Start geckodriver
geckodriver --port 4444 &
GECKO_PID=$!
sleep 2

cleanup() { kill $GECKO_PID 2>/dev/null || true; }
trap cleanup EXIT

# Run the browser test
SCREENSHOT_FILE="$SCRIPT_DIR/screenshot.png" \
GECKODRIVER_URL=http://127.0.0.1:4444 \
  node "$SCRIPT_DIR/remote-browser.js"
