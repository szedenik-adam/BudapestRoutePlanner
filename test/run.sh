#!/bin/bash
# Run tests for BudapestRoutePlanner
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$REPO_ROOT/test"
BROWSER_TEST="${BROWSER_TEST:-auto}"  # auto|on|off

echo "=== Timetable Smoke Test ==="
node "$TEST_DIR/smoke.js"

if [ "$BROWSER_TEST" = "off" ]; then
  echo ""
  echo "Browser test: skipped (BROWSER_TEST=off)"
  exit 0
fi

# Only run browser test on CI (x86 Ubuntu with Xvfb)
HAS_XVFB="$(command -v xvfb-run >/dev/null 2>&1 && echo 1 || echo 0)"
HAS_FIREFOX="$(command -v firefox-esr >/dev/null 2>&1 && echo 1 || (command -v firefox >/dev/null 2>&1 && echo 1 || echo 0))"
IS_ARM="$(uname -m | grep -q 'aarch64\|arm' && echo 1 || echo 0)"

if [ "$BROWSER_TEST" = "auto" ] && [ "$HAS_XVFB" = "0" -o "$HAS_FIREFOX" = "0" -o "$IS_ARM" = "1" ]; then
  echo ""
  echo "Browser test: skipped (Xvfb/Firefox not available or ARM architecture)"
  exit 0
fi

echo ""
echo "=== Browser Test (Firefox headless + Xvfb) ==="

# Take screenshot after test for artifact
SCREENSHOT_DIR="$TEST_DIR"
SCREENSHOT_FILE="$SCREENSHOT_DIR/screenshot.png"

PROFILE_DIR=$(mktemp -d /tmp/firefox-test-profile.XXXXXX)
cleanup() { rm -rf "$PROFILE_DIR" /tmp/brp-firefox-output.log /tmp/brp-server.log; }
trap cleanup EXIT

cat > "$PROFILE_DIR/user.js" << 'PREFS'
user_pref("app.update.auto", false);
user_pref("app.update.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("dom.disable_open_during_load", false);
user_pref("browser.tabs.remote.autostart", false);
user_pref("browser.dom.window.dump.enabled", true);
PREFS

cd "$REPO_ROOT"
python3 -u -m http.server 8899 --bind 127.0.0.1 > /tmp/brp-server.log 2>&1 &
SERVER_PID=$!
kill_server() { kill $SERVER_PID 2>/dev/null || true; }
trap "kill_server; cleanup" EXIT
sleep 1

FIREFOX_BIN="$(command -v firefox-esr || command -v firefox || echo firefox)"
xvfb-run --auto-servernum --server-args="-screen 0 1280x800x24" \
  $FIREFOX_BIN --headless --no-remote --profile "$PROFILE_DIR" \
  "http://127.0.0.1:8899/test/test.html" \
  > /tmp/brp-firefox-output.log 2>&1 &
FIREFOX_PID=$!

TIMEOUT=180
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if grep -q 'BRP-TEST-RESULT: PASS' /tmp/brp-firefox-output.log 2>/dev/null; then
    echo "BROWSER TEST: PASS"
    kill $FIREFOX_PID 2>/dev/null || true
    exit 0
  fi
  if grep -q 'BRP-TEST-RESULT: FAIL' /tmp/brp-firefox-output.log 2>/dev/null; then
    echo "BROWSER TEST: FAIL"
    grep 'BRP-TEST:' /tmp/brp-firefox-output.log 2>/dev/null || true
    kill $FIREFOX_PID 2>/dev/null || true
    exit 1
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

echo "BROWSER TEST: TIMEOUT"
grep 'BRP-TEST:' /tmp/brp-firefox-output.log 2>/dev/null || echo "(none)"
kill $FIREFOX_PID 2>/dev/null || true
exit 1
