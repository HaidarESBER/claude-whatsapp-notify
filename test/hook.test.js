const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, freePort, tempDir } = require('../testutil/helpers');

// A stand-in notifier that records what hook.js sends and answers with a canned reply
let stub, port, dir, tokenPath;
let received = [];
let reply = { answer: 'allow' };

before(async () => {
  dir = tempDir();
  tokenPath = path.join(dir, '.api-token');
  fs.writeFileSync(tokenPath, 'a'.repeat(64));
  port = await freePort();
  stub = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(data || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => stub.listen(port, '127.0.0.1', r));
});

after(() => {
  stub?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function runHook(event, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'hook.js'), event], {
      env: { ...process.env, CLAUDE_WA_PORT: String(port), CLAUDE_WA_TOKEN_FILE: tokenPath, ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify(input));
  });
}

const permission = (command) => ({ cwd: '/tmp/proj', tool_name: 'Bash', tool_input: { command } });

test('a short command is sent with the bearer token and not flagged', async () => {
  received = [];
  reply = { answer: 'allow' };
  await runHook('permission', permission('npm test'), { CLAUDE_WA_REMOTE: '1' });
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/ask');
  assert.equal(received[0].auth, `Bearer ${'a'.repeat(64)}`);
  assert.equal(received[0].body.truncated, false);
  assert.match(received[0].body.text, /npm test/);
});

test('"allow" from the notifier becomes an allow decision for Claude Code', async () => {
  reply = { answer: 'allow' };
  const out = JSON.parse(await runHook('permission', permission('ls'), { CLAUDE_WA_REMOTE: '1' }));
  assert.deepEqual(out.hookSpecificOutput.decision, { behavior: 'allow' });
});

test('"deny" from the notifier becomes a deny decision with a reason', async () => {
  reply = { answer: 'deny' };
  const out = JSON.parse(await runHook('permission', permission('rm -rf x'), { CLAUDE_WA_REMOTE: '1' }));
  assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(out.hookSpecificOutput.decision.message, /WhatsApp/);
});

test('a command over 3000 characters is flagged truncated and cut to the preview limit', async () => {
  received = [];
  reply = { answer: 'deny', reason: 'too-long' };
  await runHook('permission', permission('echo ' + 'A'.repeat(5000) + '; rm -rf ~'), { CLAUDE_WA_REMOTE: '1' });
  const body = received[0].body;
  assert.equal(body.truncated, true);
  assert.ok(body.text.length < 3200, `preview was ${body.text.length} chars`);
  assert.ok(!body.text.includes('rm -rf ~'), 'the hidden tail must not be in the preview');
});

test('no answer from the notifier prints nothing, so the terminal prompt appears', async () => {
  reply = { answer: null, reason: 'not-away' };
  const out = await runHook('permission', permission('ls'));
  assert.equal(out, '');
});

test('with the notifier down, the hook exits quietly and prints nothing', async () => {
  const dead = await freePort();
  const out = await runHook('permission', permission('ls'), { CLAUDE_WA_PORT: String(dead) });
  assert.equal(out, '');
});

test('a missing token file still lets the hook run (it just gets refused by the server)', async () => {
  received = [];
  reply = { answer: null };
  await runHook('permission', permission('ls'), { CLAUDE_WA_TOKEN_FILE: path.join(dir, 'missing') });
  assert.equal(received[0].auth, 'Bearer'); // no token to send
});
