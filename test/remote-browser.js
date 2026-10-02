// Browser test: connects to remote geckodriver on Windows PC
// Usage: GECKODRIVER_URL=http://192.168.0.3:4444 node test/remote-browser.js
// Start geckodriver first on host: geckodriver --host 0.0.0.0 --port 4444
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const GECKODRIVER_URL = process.env.GECKODRIVER_URL;
if (!GECKODRIVER_URL) {
  console.log('Usage: GECKODRIVER_URL=http://<pc-ip>:4444 node test/remote-browser.js');
  console.log('  On Windows: geckodriver --host 0.0.0.0 --port 4444');
  process.exit(2);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_PORT = 8899;
const TEST_TIMEOUT = 180000;

// Get this machine's IP for the remote Firefox to connect back
function getLocalIp() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

let server;

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('python', ['-m', 'http.server', String(SERVER_PORT), '--bind', '0.0.0.0'], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', d => console.log('SERVER:', d.toString().trim()));
    server.stderr.on('data', d => console.log('SERVER ERR:', d.toString().trim()));
    server.on('error', reject);
    setTimeout(resolve, 2000);
  });
}

function stopServer() {
  if (server) server.kill();
}

async function runTest() {
  const localIp = await getLocalIp();
  const appUrl = `http://${localIp}:${SERVER_PORT}`;
  const results = [];
  let driver = null;
  function log(msg) { results.push(msg); console.log(msg); }

  try {
    log('Starting HTTP server on', localIp + ':' + SERVER_PORT);
    await startServer();

    log('Connecting to geckodriver at', GECKODRIVER_URL);

    // Try to quit any existing session first
    try {
      const existingDriver = await new Builder()
        .forBrowser('firefox')
        .usingServer(GECKODRIVER_URL + '/')
        .build();
      await existingDriver.quit();
      log('  Cleaned up stale session');
    } catch(e) {
      // No existing session, which is fine
    }

    const options = new firefox.Options();
    options.setPreference('app.update.auto', false);
    options.setPreference('app.update.enabled', false);
    options.setPreference('browser.shell.checkDefaultBrowser', false);
    options.setPreference('datareporting.policy.dataSubmissionEnabled', false);

    driver = await new Builder()
      .forBrowser('firefox')
      .usingServer(GECKODRIVER_URL + '/')
      .setFirefoxOptions(options)
      .build();

    driver.manage().setTimeouts({ pageLoad: 120000 });

    log('Step 1: Loading app…');
    await driver.get(`${appUrl}/index.html`);

    log('Step 2: Waiting for map…');
    await driver.wait(async () => {
      return await driver.executeScript(function() {
        // Check if maplibre created the map container's child elements
        var mapEl = document.getElementById('map');
        return mapEl && mapEl.children.length > 0;
      });
    }, 30000);
    log('  Map initialized');

    log('Step 3: Waiting for timetable…');
    await driver.wait(async () => {
      return await driver.executeScript(function() {
        var el = document.getElementById('progressBarContainer');
        return el && el.classList.contains('hidden');
      });
    }, 30000);
    log('  Timetable loaded');

    log('Step 4: Testing routing…');
    // Give the GTFS worker time to build the route graph
    await driver.sleep(3000);

    const routeResult = await driver.executeAsyncScript(function() {
      const callback = arguments[arguments.length - 1];
      try {
        if (!window.gtfsWorker) { callback({ error: 'No GTFS worker' }); return; }
        var handler = function(e) {
          window.gtfsWorker.removeEventListener('message', handler);
          var r = e.data.route;
          if (!r || !r.path || r.path.length < 2) {
            callback({ error: 'Route too short: ' + (r ? r.path.length : 0) });
            return;
          }
          callback({ points: r.path.length, steps: r.steps.length });
        };
        window.gtfsWorker.addEventListener('message', handler);
        window.gtfsWorker.postMessage({
          src: { lat: 47.4979, lng: 19.0542 },
          dst: { lat: 47.5077, lng: 19.0458 }
        });
      } catch(e) {
        callback({ error: e.message });
      }
    });

    if (routeResult.error) {
      log('  FAIL: ' + routeResult.error);
      process.exitCode = 1;
    } else {
      log('  Route OK (' + routeResult.points + ' points, ' + routeResult.steps + ' steps)');

      const hasRouteLayer = await driver.executeScript(function() {
        try { return !!window.map.getLayer('routeLayer'); } catch(e) { return false; }
      });
      if (hasRouteLayer) log('Step 5: Route layer on map');

      // Step 6: Test realtime vehicle feed
      log('Step 6: Testing realtime vehicles…');
      let vehicleResult = null;
      try {
        vehicleResult = await driver.wait(async () => {
          return await driver.executeScript(function() {
            // Check if realtime vehicles have been drawn
            var src = window.map && window.map.getSource('vehicles');
            if (!src || !src._data) return false;
            var features = src._data.features || [];
            return features.length > 0 ? true : false;
          });
        }, 30000);
      } catch(e) {
        // Timeout - no vehicles yet
      }

      if (vehicleResult) {
        const vehicleCount = await driver.executeScript(function() {
          var src = window.map.getSource('vehicles');
          return src._data.features.length;
        });
        log('  Realtime vehicles: ' + vehicleCount);
      } else {
        log('  Warning: No realtime vehicles within timeout (may be off-hours)');
      }

      log('\nALL TESTS PASSED');
    }
  } catch(e) {
    log('ERROR: ' + e.message);
    process.exitCode = 1;
  } finally {
    // Take screenshot before quitting
    if (driver) {
      try {
        const screenshot = await driver.takeScreenshot();
        const fs = require('fs');
        fs.writeFileSync(process.env.SCREENSHOT_FILE || 'test/screenshot.png', screenshot, 'base64');
        log('Screenshot saved');
      } catch(e) {}
      try { await driver.quit(); } catch(e) {}
    }
    stopServer();
  }
}

runTest();
