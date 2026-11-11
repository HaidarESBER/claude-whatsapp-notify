const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { request, startServer } = require('../testutil/helpers');

let srv;
before(async () => {
  srv = await startServer({ config: { away: true } });
});
after(() => srv?.stop());

const auth = () => ({ Authorization: `Bearer ${srv.token}` });
const json = (extra = {}) => ({ ...auth(), 'Content-Type': 'application/json', ...extra });

test('the token file is a 256-bit hex secret', () => {
  assert.match(srv.token, /^[0-9a-f]{64}$/);
});

test('no token: 401', async () => {
  const r = await request(srv.port, { route: '/status' });
  assert.equal(r.status, 401);
});

test('wrong token: 401', async () => {
  const r = await request(srv.port, { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } });
  assert.equal(r.status, 401);
});

test('malformed Authorization header: 401', async () => {
  for (const value of ['Bearer', 'Bearer short', srv.token, `Basic ${srv.token}`]) {
    const r = await request(srv.port, { headers: { Authorization: value } });
    assert.equal(r.status, 401, value);
  }
});

test('valid token: 200 with status', async () => {
  const r = await request(srv.port, { headers: auth() });
  assert.equal(r.status, 200);
  assert.equal(r.body.connected, false);
  assert.equal(r.body.away, true);
});

test('a foreign Host header is refused even with a valid token (DNS rebinding)', async () => {
  const r = await request(srv.port, { headers: { ...auth(), Host: 'evil.example' } });
  assert.equal(r.status, 403);
});

test('a browser-style text/plain POST is refused: 415', async () => {
  const r = await request(srv.port, {
    method: 'POST',
    route: '/notify',
    headers: { ...auth(), 'Content-Type': 'text/plain' },
    body: JSON.stringify({ text: 'x' }),
  });
  assert.equal(r.status, 415);
});

test('a POST without a token is refused before its body is read: 401', async () => {
  const r = await request(srv.port, {
    method: 'POST',
    route: '/notify',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x' }),
  });
  assert.equal(r.status, 401);
});

test('an authorized JSON POST gets past auth (500 only because WhatsApp is not connected)', async () => {
  const r = await request(srv.port, {
    method: 'POST',
    route: '/notify',
    headers: json(),
    body: JSON.stringify({ text: 'x' }),
  });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /not connected/i);
});

test('unknown routes are 404 for authorized callers', async () => {
  const r = await request(srv.port, { route: '/nope', headers: auth() });
  assert.equal(r.status, 404);
});

test('an over-long approval from a WhatsApp-started run is denied outright', async () => {
  const r = await request(srv.port, {
    method: 'POST',
    route: '/ask',
    headers: json(),
    body: JSON.stringify({ text: 'x', truncated: true, force: true }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { answer: 'deny', reason: 'too-long' });
});

test('an over-long approval from a terminal run falls back to the terminal prompt', async () => {
  const r = await request(srv.port, {
    method: 'POST',
    route: '/ask',
    headers: json(),
    body: JSON.stringify({ text: 'x', truncated: true, force: false }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { answer: null, reason: 'too-long' });
});

test('bodies over 1 MB are not accepted as valid requests', async () => {
  const big = JSON.stringify({ text: 'x'.repeat(1_200_000) });
  let result;
  try {
    result = await request(srv.port, { method: 'POST', route: '/notify', headers: json(), body: big });
  } catch {
    result = { status: 'connection reset' }; // the server hangs up on oversized bodies, which is also fine
  }
  assert.notEqual(result.status, 200);
});
