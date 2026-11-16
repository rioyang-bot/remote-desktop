'use strict';
/**
 * 遠端桌面信令伺服器
 *
 * 職責：
 *  1. 被控端 (host) 註冊並取得固定的 9 位數 ID
 *  2. 控制端 (viewer) 用 ID 發起連線，伺服器把雙方的訊息互相轉送
 *     （密碼驗證在被控端完成，伺服器看不到密碼）
 *  3. 發放 STUN / TURN 設定（TURN 使用 coturn 的 REST API 臨時帳密）
 *  4. 提供控制端網頁 (public/)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// 若有 server/.env 就自動載入（Windows 上不用另外設環境變數）
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {}

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

const PORT = parseInt(process.env.PORT || '8080', 10);
const BIND = process.env.BIND || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STUN_URLS = list(process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302');
const TURN_URLS = list(process.env.TURN_URLS);
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_TTL = parseInt(process.env.TURN_TTL || '86400', 10);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MAX_CONNECT_PER_MIN = parseInt(process.env.MAX_CONNECT_PER_MIN || '15', 10);
// Cloudflare TURN（選用）：在 Cloudflare 後台 Realtime → TURN 建立金鑰
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID || '';
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN || '';

/* ------------------------------------------------------------------ */
/* 裝置註冊表（ID ↔ 密鑰雜湊），存在 data/devices.json                  */
/* ------------------------------------------------------------------ */
const REG_FILE = path.join(DATA_DIR, 'devices.json');
let devices = {};
try {
  devices = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
} catch {
  devices = {};
}
let saveTimer = null;
function saveDevices() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = REG_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(devices, null, 2));
      fs.renameSync(tmp, REG_FILE);
    } catch (e) {
      console.error('[registry] save failed:', e.message);
    }
  }, 500);
}
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function allocateId() {
  for (;;) {
    const id = String(crypto.randomInt(100000000, 1000000000));
    if (!devices[id]) return id;
  }
}

/* ------------------------------------------------------------------ */
/* ICE 伺服器設定                                                       */
/* ------------------------------------------------------------------ */
let cfCache = { servers: null, expires: 0 };

/** 向 Cloudflare 取得臨時 TURN 帳密（快取 12 小時，帳密本身有效 24 小時） */
async function cloudflareIce() {
  if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) return [];
  if (cfCache.servers && Date.now() < cfCache.expires) return cfCache.servers;
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${CF_TURN_API_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const raw = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
    // 瀏覽器會擋 53 埠，去掉以免拖慢連線
    const servers = raw
      .map((s) => ({ ...s, urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) }))
      .filter((s) => s.urls.length);
    cfCache = { servers, expires: Date.now() + 12 * 3600 * 1000 };
    return servers;
  } catch (e) {
    console.error('[turn] Cloudflare TURN 取得失敗：', e.message);
    cfCache = { servers: [], expires: Date.now() + 60 * 1000 }; // 一分鐘後再試
    return [];
  }
}

async function iceServers(user) {
  const out = [];
  if (STUN_URLS.length) out.push({ urls: STUN_URLS });
  if (TURN_URLS.length && TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${user}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    out.push({ urls: TURN_URLS, username, credential });
  }
  out.push(...(await cloudflareIce()));
  return out;
}

/* ------------------------------------------------------------------ */
/* 靜態檔案（控制端網頁）                                               */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hosts: hosts.size, sessions: sessions.size }));
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    });
    res.end(buf);
  });
});

/* ------------------------------------------------------------------ */
/* WebSocket 信令                                                       */
/* ------------------------------------------------------------------ */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
const hosts = new Map(); // id -> ws
const sessions = new Map(); // sid -> { host, viewer, id }
const rate = new Map(); // ip -> [timestamps]

const HOST_SENDS = new Set(['challenge', 'auth-result', 'signal', 'bye']);
const VIEWER_SENDS = new Set(['auth', 'signal', 'bye']);

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function clientIp(req) {
  if (TRUST_PROXY) {
    // Cloudflare Tunnel 會帶 CF-Connecting-IP；Caddy 等反向代理用 X-Forwarded-For
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (rate.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  rate.set(ip, arr);
  return arr.length > MAX_CONNECT_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of rate) if (!arr.some((t) => now - t < 60000)) rate.delete(ip);
}, 60000).unref();

function endSession(sid, reason, from) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  if (from !== s.host) send(s.host, { t: 'bye', sid, reason });
  if (from !== s.viewer) send(s.viewer, { t: 'bye', sid, reason });
  if (s.viewer && s.viewer.sid === sid) s.viewer.sid = null;
}

async function hostHello(ws, msg) {
  if (ws.role) return;
  ws.role = 'host-pending';
  let id = typeof msg.id === 'string' ? msg.id : '';
  let secret = typeof msg.secret === 'string' ? msg.secret : '';
  let issued = false;
  if (!(id && secret && devices[id] && devices[id].secretHash === sha256hex(secret))) {
    id = allocateId();
    secret = crypto.randomBytes(32).toString('hex');
    devices[id] = { secretHash: sha256hex(secret), created: new Date().toISOString() };
    issued = true;
  }
  devices[id].lastSeen = new Date().toISOString();
  saveDevices();

  const ice = await iceServers(id);
  if (ws.readyState !== 1) return;
  const old = hosts.get(id);
  if (old && old !== ws) {
    send(old, { t: 'replaced' });
    old.close(4000, 'replaced');
  }
  ws.role = 'host';
  ws.deviceId = id;
  hosts.set(id, ws);
  send(ws, { t: 'host-ok', id, secret: issued ? secret : undefined, iceServers: ice });
  console.log(`[host] ${id} online from ${ws.ip}${issued ? ' (new id)' : ''}`);
}

async function viewerConnect(ws, msg) {
  if (ws.role === 'host' || ws.role === 'host-pending') return;
  if (rateLimited(ws.ip)) {
    send(ws, { t: 'error', code: 'rate-limited' });
    return;
  }
  const id = String(msg.id || '').replace(/\D/g, '');
  const host = hosts.get(id);
  if (!host) {
    send(ws, { t: 'error', code: 'offline' });
    return;
  }
  if (ws.sid) endSession(ws.sid, 'viewer-reconnect', ws);
  const sid = crypto.randomBytes(12).toString('hex');
  ws.role = 'viewer';
  ws.sid = sid;
  sessions.set(sid, { host, viewer: ws, id });
  const [hostIce, viewerIce] = await Promise.all([iceServers(id), iceServers('viewer')]);
  if (!sessions.has(sid)) return; // 等待期間有一方離開
  send(host, { t: 'session-request', sid, from: ws.ip, iceServers: hostIce });
  send(ws, { t: 'session-pending', sid, iceServers: viewerIce });
  console.log(`[session] ${sid} ${ws.ip} -> ${id}`);
}

function relay(ws, msg) {
  const s = sessions.get(msg.sid);
  if (!s) return;
  let peer;
  if (ws === s.host && HOST_SENDS.has(msg.t)) peer = s.viewer;
  else if (ws === s.viewer && VIEWER_SENDS.has(msg.t)) peer = s.host;
  else return;
  if (msg.t === 'bye') {
    endSession(msg.sid, msg.reason || 'closed', ws);
    return;
  }
  send(peer, msg);
}

wss.on('connection', (ws, req) => {
  ws.ip = clientIp(req);
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'host-hello':
        return hostHello(ws, msg);
      case 'viewer-connect':
        return viewerConnect(ws, msg);
      case 'challenge':
      case 'auth':
      case 'auth-result':
      case 'signal':
      case 'bye':
        return relay(ws, msg);
      case 'ping':
        return send(ws, { t: 'pong' });
    }
  });
  ws.on('close', () => {
    if (ws.role === 'host') {
      if (hosts.get(ws.deviceId) === ws) hosts.delete(ws.deviceId);
      for (const [sid, s] of sessions) if (s.host === ws) endSession(sid, 'host-offline', ws);
      console.log(`[host] ${ws.deviceId} offline`);
    } else if (ws.role === 'viewer' && ws.sid) {
      endSession(ws.sid, 'viewer-left', ws);
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25000).unref();

server.listen(PORT, BIND, () => {
  console.log(`RD 信令伺服器已啟動 http://${BIND}:${PORT}`);
  console.log(`  STUN: ${STUN_URLS.join(', ') || '(無)'}`);
  const turns = [];
  if (TURN_URLS.length && TURN_SECRET) turns.push(TURN_URLS.join(', '));
  if (CF_TURN_KEY_ID && CF_TURN_API_TOKEN) turns.push('Cloudflare TURN');
  console.log(`  TURN: ${turns.join(' + ') || '(未設定)'}`);
  if (TRUST_PROXY) console.log('  信任反向代理（Cloudflare / Caddy）傳來的用戶端 IP');
});
