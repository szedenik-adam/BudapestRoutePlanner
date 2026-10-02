// HTTP server that exposes the browser test via a simple API
// Run on Windows: node test-server.js
// Then from Linux: curl http://<pc-ip>:8890/run
import http from 'http';
import { spawn } from 'child_process';

const PORT = 8890;
const APP_PORT = 8899;

const server = http.createServer((req, res) => {
  if (req.url === '/run') {
    console.log('Test requested from', req.socket.remoteAddress);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Test running…\n');

    const child = spawn('node', ['run-browser.js'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', d => { output += d.toString(); res.write(d); });
    child.stderr.on('data', d => { output += d.toString(); });

    child.on('close', code => {
      res.end(code === 0 ? '\nPASS' : '\nFAIL');
    });
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <h1>BRP Test Server</h1>
      <p><a href="/run">Run browser test</a></p>
      <p>App: <a href="http://127.0.0.1:${APP_PORT}/">http://127.0.0.1:${APP_PORT}/</a></p>
    `);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Test server on http://0.0.0.0:${PORT}`);
  console.log('  GET /run  →  run browser test`);
});
