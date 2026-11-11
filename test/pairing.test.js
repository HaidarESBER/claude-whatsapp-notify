const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPairing } = require('../pairing');

function make(overrides = {}) {
  let t = 1_000_000;
  const rotations = [];
  const pairing = createPairing({
    now: () => t,
    onRotate: (code, reason) => rotations.push({ code, reason }),
    ...overrides,
  });
  return { pairing, rotations, advance: (ms) => (t += ms) };
}

test('the current code pairs', () => {
  const { pairing } = make();
  assert.match(pairing.code, /^\d{6}$/);
  assert.equal(pairing.tryPair(`link ${pairing.code}`), true);
});

test('matching is case-insensitive and ignores surrounding whitespace', () => {
  const { pairing } = make();
  assert.equal(pairing.tryPair(`  LINK ${pairing.code}  `), true);
});

test('a wrong code is rejected', () => {
  const { pairing } = make();
  const wrong = pairing.code === '000000' ? '000001' : '000000';
  assert.equal(pairing.tryPair(`link ${wrong}`), false);
});

test('junk and malformed messages are rejected without counting as guesses', () => {
  const { pairing, rotations } = make();
  const code = pairing.code;
  for (const text of ['hello', 'link', 'link abc', 'link 12345', 'link 1234567', `link ${code} extra`, '']) {
    assert.equal(pairing.tryPair(text), false, JSON.stringify(text));
  }
  assert.equal(rotations.length, 0);
  assert.equal(pairing.code, code);
});

test('four wrong guesses keep the code, the fifth rotates it', () => {
  const { pairing, rotations } = make();
  const original = pairing.code;
  const wrong = original === '000000' ? '000001' : '000000';
  for (let i = 0; i < 4; i++) pairing.tryPair(`link ${wrong}`);
  assert.equal(pairing.code, original);
  pairing.tryPair(`link ${wrong}`);
  assert.notEqual(pairing.code, original);
  assert.equal(rotations.length, 1);
  assert.match(rotations[0].reason, /too many wrong attempts/);
});

test('the old code is rejected after a rotation, the new one works', () => {
  const { pairing } = make({ maxFailures: 1 });
  const original = pairing.code;
  const wrong = original === '000000' ? '000001' : '000000';
  pairing.tryPair(`link ${wrong}`); // rotates immediately
  assert.equal(pairing.tryPair(`link ${original}`), false);
  assert.equal(pairing.tryPair(`link ${pairing.code}`), true);
});

test('a code older than the TTL is rejected and replaced', () => {
  const { pairing, rotations, advance } = make({ ttlMs: 10 * 60 * 1000 });
  const original = pairing.code;
  advance(10 * 60 * 1000 + 1);
  assert.equal(pairing.tryPair(`link ${original}`), false);
  assert.equal(rotations[0].reason, 'expired');
  assert.notEqual(pairing.code, original);
});

test('a code still inside the TTL works', () => {
  const { pairing, advance } = make({ ttlMs: 10 * 60 * 1000 });
  advance(9 * 60 * 1000);
  assert.equal(pairing.tryPair(`link ${pairing.code}`), true);
});

test('restartTimer starts the expiry clock over', () => {
  const { pairing, advance } = make({ ttlMs: 10 * 60 * 1000 });
  const original = pairing.code;
  advance(9 * 60 * 1000);
  pairing.restartTimer();
  advance(9 * 60 * 1000); // 18 minutes since creation, 9 since restart
  assert.equal(pairing.tryPair(`link ${original}`), true);
});
