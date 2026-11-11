// Shared helpers for tests that start the real notifier (without WhatsApp) in a temp directory.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cwn-test-'));
}

// Minimal HTTP request helper: resolves { status, body } and never throws on non-2xx
function request(port, { method = 'GET', route = '/status', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(out);
        } catch {}
        resolve({ status: res.statusCode, body: json, raw: out });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Starts server.js with only its HTTP API (no WhatsApp), isolated config and token
async function startServer({ config = {} } = {}) {
  const dir = tempDir();
  const port = await freePort();
  const configPath = path.join(dir, 'config.json');
  const tokenPath = path.join(dir, '.api-token');
  fs.writeFileSync(configPath, JSON.stringify(config));

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      CLAUDE_WA_PORT: String(port),
      CLAUDE_WA_NO_BOT: '1',
      CLAUDE_WA_CONFIG: configPath,
      CLAUDE_WA_TOKEN_FILE: tokenPath,
    },
    stdio: 'ignore',
  });

  // Wait until the API answers (any status counts as "up")
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await request(port);
      break;
    } catch {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error('server did not start in time');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    port,
    token: fs.readFileSync(tokenPath, 'utf8').trim(),
    tokenPath,
    dir,
    stop: () => {
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { ROOT, freePort, tempDir, request, startServer };
