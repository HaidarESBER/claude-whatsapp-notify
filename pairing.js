// One-time pairing code that links the owner's phone to the bot.
// The code expires after `ttlMs` and rotates after `maxFailures` wrong guesses,
// and is compared in constant time, so it can't be brute-forced over WhatsApp.
const crypto = require('crypto');

function createPairing({ ttlMs = 10 * 60 * 1000, maxFailures = 5, now = Date.now, onRotate = () => {} } = {}) {
  const newCode = () => String(crypto.randomInt(100000, 1000000));
  let code = newCode();
  let issuedAt = now();
  let failures = 0;

  function rotate(reason) {
    code = newCode();
    issuedAt = now();
    failures = 0;
    onRotate(code, reason);
  }

  return {
    get code() {
      return code;
    },
    // Start the expiry clock again (called once WhatsApp is connected)
    restartTimer() {
      issuedAt = now();
      failures = 0;
    },
    // True only for the right, unexpired code
    tryPair(text) {
      if (now() - issuedAt > ttlMs) rotate('expired');
      const m = String(text).trim().match(/^link\s+(\d{6})$/i);
      if (!m) return false;
      const a = Buffer.from(m[1]);
      const b = Buffer.from(code);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
      if (++failures >= maxFailures) rotate('rotated after too many wrong attempts');
      return false;
    },
  };
}

module.exports = { createPairing };
