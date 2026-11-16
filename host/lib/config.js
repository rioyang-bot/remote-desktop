'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 內建伺服器位址：打包前編輯 host/server.json，客戶開啟程式就會自動連到你的伺服器。
 * 使用者在設定裡改過位址時，以使用者的為準。
 */
function builtinServerUrl() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server.json'), 'utf8'));
    return toWsUrl(j.serverUrl) || 'ws://localhost:8080/ws';
  } catch {
    return 'ws://localhost:8080/ws';
  }
}

const DEFAULTS = {
  serverUrl: null, // null = 使用內建位址
  id: null,
  secret: null,
  salt: null,
  permKey: null,
  permPw: null, // 固定密碼（DPAPI 加密，base64），給「眼睛」按鈕顯示用
  autoStart: false,
  saved: [], // 記住密碼的電腦 [{ target: 電腦名稱或 IP, pw: DPAPI 加密後的密碼(base64) }]
};

class Config {
  constructor(dir) {
    this.file = path.join(dir, 'config.json');
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    this.builtinServerUrl = builtinServerUrl();
    this.data = { ...DEFAULTS, ...data };
    this.data.serverUrl = toWsUrl(this.data.serverUrl);
    if (this.data.serverUrl === this.builtinServerUrl) this.data.serverUrl = null;
    if (!this.data.salt) {
      this.data.salt = crypto.randomBytes(16).toString('hex');
      this.save();
    }
  }

  get(k) {
    if (k === 'serverUrl') return this.data.serverUrl || this.builtinServerUrl;
    return this.data[k];
  }

  /** 設定伺服器位址；與內建位址相同時存成 null，之後換版本的內建位址才會生效 */
  setServerUrl(ws) {
    this.set({ serverUrl: ws === this.builtinServerUrl ? null : ws });
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

/** 使用者可能輸入 https://rd.example.com、rd.example.com:8080 或 ws://... → 統一轉成 ws(s)://host/ws */
function toWsUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = (/^(localhost|127\.|10\.|192\.168\.)/.test(s) ? 'ws://' : 'wss://') + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
  return u.toString();
}

module.exports = { Config, toWsUrl };
