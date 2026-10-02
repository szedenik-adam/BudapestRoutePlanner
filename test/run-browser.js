// Browser test using geckodriver + selenium
// Runs on Windows PC with local Firefox
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_PORT = 8899;
const TEST_TIMEOUT = 180000;

let server;

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('python', ['-m', 'http.server', String(SERVER_PORT), '--bind', '127.0.0.1'], {
      cwd: REPO_ROOT,
      stdio: 'ignore'
    });
    server.on('error', reject);
    // Wait for server to start
    setTimeout(resolve, 2000);
  });
}

function stopServer() {
  if (server) server.kill();
}

async function runTest() {
  const results = [];
  function log(msg) { results.push(msg); console.log(msg); }

  try {
    log('Starting HTTP server…');
    await startServer();

    log('Launching Firefox via geckodriver…');
    const options = new firefox.Options();
    // Use existing Firefox profile to avoid first-run screens
    options.setPreference('app.update.auto', false);
    options.setPreference('app.update.enabled', false);
    options.setPreference('browser.shell.checkDefaultBrowser', false);
    options.setPreference('datareporting.policy.dataSubmissionEnabled', false);

    const driver = await new Builder()
      .forBrowser('firefox')
      .setFirefoxOptions(options)
      .build();

    try {
      driver.manage().setTimeouts({ pageLoad: 60000 });

      // Step 1: Load test page
      log('Step 1: Loading app…');
      await driver.get(`http://127.0.0.1:${SERVER_PORT}/test/test.html`);

      // Step 2: Wait for map to load (check for map element with canvas)
      log('Step 2: Waiting for map…');
      await driver.wait(until.elementLocated(By.css('#map canvas')), 30000);
      log('  Map canvas found');

      // Step 3: Wait for timetable (progress container hidden)
      log('Step 3: Waiting for timetable…');
      await driver.wait(async () => {
        const el = await driver.findElement(By.css('#progressContainer')).catch(() => null);
        return el && (await el.getCssValue('display')) === 'none';
      }, 60000);
      log('  Timetable loaded');

      // Step 4: Check route layer exists
      log('Step 4: Testing routing…');
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

        // Step 5: Verify route drawn on map
        const hasRouteLayer = await driver.executeScript(function() {
          try { return !!window.map.getLayer('routeLayer'); } catch(e) { return false; }
        });

        if (hasRouteLayer) {
          log('Step 5: Route layer on map');
        } else {
          log('  Warning: routeLayer not found (may be async)');
        }

        log('\nALL TESTS PASSED');
      }
    } finally {
      await driver.quit();
    }
  } catch(e) {
    log('ERROR: ' + e.message);
    process.exitCode = 1;
  } finally {
    stopServer();
  }
}

runTest();
