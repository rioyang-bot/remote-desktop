'use strict';
/**
 * 密碼驗證（挑戰-回應）
 *
 *  被控端送出隨機 nonce + salt
 *  控制端回傳 proof = HMAC-SHA256( SHA256(salt + ':' + password), nonce )
 *  被控端比對 → 密碼本身從不經過伺服器
 *
 * 支援兩種密碼：
 *  - 一次性密碼：每次啟動隨機產生，可手動更換
 *  - 固定密碼：使用者自訂，用於無人值守；只存衍生金鑰，不存明文
 */
const crypto = require('crypto');

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const LOCK_MS = 60 * 1000;
const CHALLENGE_TTL_MS = 60 * 1000;

function randomPassword(len = 8) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

function deriveKey(salt, password) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest();
}

class Auth {
  /**
   * @param {{ salt: string, permKey: string|null }} cfg
   */
  constructor(cfg) {
    this.salt = cfg.salt;
    this.permKey = cfg.permKey ? Buffer.from(cfg.permKey, 'hex') : null;
    this.challenges = new Map();
    this.fails = [];
    this.lockedUntil = 0;
    this.refreshOtp();
  }

  refreshOtp() {
    this.otp = randomPassword();
    this.otpKey = deriveKey(this.salt, this.otp);
    return this.otp;
  }

  /** 設定固定密碼，回傳要存進設定檔的衍生金鑰 (hex)；傳 null 代表取消 */
  setPermanent(password) {
    if (!password) {
      this.permKey = null;
      return null;
    }
    this.permKey = deriveKey(this.salt, password);
    return this.permKey.toString('hex');
  }

  newChallenge(sid) {
    const nonce = crypto.randomBytes(16).toString('hex');
    this.challenges.set(sid, { nonce, at: Date.now() });
    for (const [k, v] of this.challenges) if (Date.now() - v.at > CHALLENGE_TTL_MS) this.challenges.delete(k);
    return { nonce, salt: this.salt };
  }

  /** @returns {{ ok: boolean, reason?: string, kind?: 'otp'|'permanent' }} */
  verify(sid, proofHex) {
    const now = Date.now();
    const ch = this.challenges.get(sid);
    this.challenges.delete(sid); // nonce 只能用一次
    if (now < this.lockedUntil) return { ok: false, reason: 'locked' };
    if (!ch || now - ch.at > CHALLENGE_TTL_MS) return { ok: false, reason: 'timeout' };
    if (typeof proofHex !== 'string' || !/^[0-9a-f]{64}$/.test(proofHex)) return this._fail(now);

    const proof = Buffer.from(proofHex, 'hex');
    const check = (key) => key && crypto.timingSafeEqual(crypto.createHmac('sha256', key).update(ch.nonce).digest(), proof);
    if (check(this.otpKey)) return { ok: true, kind: 'otp' };
    if (check(this.permKey)) return { ok: true, kind: 'permanent' };
    return this._fail(now);
  }

  _fail(now) {
    this.fails = this.fails.filter((t) => now - t < FAIL_WINDOW_MS);
    this.fails.push(now);
    if (this.fails.length >= MAX_FAILS) {
      this.lockedUntil = now + LOCK_MS;
      this.fails = [];
      return { ok: false, reason: 'locked' };
    }
    return { ok: false, reason: 'wrong-password' };
  }
}

module.exports = { Auth, randomPassword, deriveKey };
