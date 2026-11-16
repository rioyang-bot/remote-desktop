'use strict';
// 驗證瀏覽器端的 SHA-256 / HMAC 與 Node crypto 結果一致
const crypto = require('crypto');
const assert = require('assert');
const H = require('../public/sha256.js');

const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), '中文密碼🔒'];
for (const s of samples) {
  const want = crypto.createHash('sha256').update(s).digest('hex');
  assert.strictEqual(H.hex(H.sha256(H.utf8(s))), want, `sha256 mismatch for len ${s.length}`);
  for (const key of ['k', 'x'.repeat(64), 'y'.repeat(100)]) {
    const wantH = crypto.createHmac('sha256', key).update(s).digest('hex');
    assert.strictEqual(H.hex(H.hmacSha256(H.utf8(key), H.utf8(s))), wantH, 'hmac mismatch');
  }
}

// 與被控端 (host/lib/auth.js) 相同的驗證流程
const salt = 'abcd1234', pw = 'Pa55word', nonce = 'n0nce';
const key = crypto.createHash('sha256').update(salt + ':' + pw).digest();
const want = crypto.createHmac('sha256', key).update(nonce).digest('hex');
assert.strictEqual(H.makeProof(pw, salt, nonce), want);

console.log('sha256 / hmac tests passed');
