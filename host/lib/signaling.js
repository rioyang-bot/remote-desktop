'use strict';
/**
 * 內建信令伺服器（直連模式）
 *
 * 每台 RD Host 都自己跑一個，只負責「這一台」，不需要中央伺服器：
 *  - 本機的被控端畫面視窗以 host 身分連進來（只接受 127.0.0.1）
 *  - 其他電腦的控制端以 viewer 身分連進來（只接受 Tailscale 位址和本機）
 *
 * 訊息格式與 server/src/server.js 相同，所以被控端與控制端程式不用改。
 * 密碼驗證由被控端自己做，這裡只負責轉送。
 */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const DEFAULT_PORT = 47821;
const ICE_SERVERS = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const MAX_CONNECT_PER_MIN = 15;

const HOST_SENDS = new Set(['challenge', 'auth-result', 'signal', 'bye']);
const VIEWER_SENDS = new Set(['auth', 'signal', 'bye']);

const normIp = (a) => String(a || '').replace(/^::ffff:/i, '').toLowerCase();
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1';
/** Tailscale 位址：100.64.0.0/10 或 fd7a:115c:a1e0::/48 */
function isTailscale(ip) {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (m) return +m[1] === 100 && (+m[2] & 0xc0) === 64;
  return ip.startsWith('fd7a:115c:a1e0:');
}
const allowed = (ip) => isLoopback(ip) || isTailscale(ip);

/**
 * @param {{ port?: number, bind?: string, log?: (...a: any[]) => void }} opts
 * @returns {Promise<{ port: number, close: () => void }>}
 */
function startSignaling({ port = DEFAULT_PORT, bind, log = () => {} } = {}) {
  let host = null;
  const sessions = new Map(); // sid -> { host, viewer }
  const rate = new Map(); // ip -> [timestamps]

  const server = http.createServer((req, res) => {
    const ip = normIp(req.socket.remoteAddress);
    if (!allowed(ip)) return void res.writeHead(403).end();
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ ok: true, app: 'rd-host', online: !!host, busy: sessions.size > 0 }));
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 256 * 1024,
    verifyClient: ({ req }) => allowed(normIp(req.socket.remoteAddress)),
  });
  // ws 會把 http 伺服器的錯誤（例如連接埠被占用）再轉拋到 wss；
  // 沒人接的話會變成未處理例外、跳出錯誤對話框。錯誤已由下方 listen 的 Promise 回報。
  wss.on('error', () => {});

  const send = (ws, obj) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  };

  function rateLimited(ip) {
    const now = Date.now();
    const arr = (rate.get(ip) || []).filter((t) => now - t < 60000);
    arr.push(now);
    rate.set(ip, arr);
    return arr.length > MAX_CONNECT_PER_MIN;
  }

  function endSession(sid, reason, from) {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    if (from !== s.host) send(s.host, { t: 'bye', sid, reason });
    if (from !== s.viewer) send(s.viewer, { t: 'bye', sid, reason });
    if (s.viewer && s.viewer.sid === sid) s.viewer.sid = null;
  }

  function hostHello(ws) {
    if (ws.role) return;
    if (!isLoopback(ws.ip)) return void ws.close(4003, 'host must be local');
    if (host && host !== ws) {
      send(host, { t: 'replaced' });
      host.close(4000, 'replaced');
    }
    ws.role = 'host';
    host = ws;
    send(ws, { t: 'host-ok', id: 'local', iceServers: ICE_SERVERS });
  }

  function viewerConnect(ws) {
    if (ws.role === 'host') return;
    if (rateLimited(ws.ip)) return send(ws, { t: 'error', code: 'rate-limited' });
    if (!host) return send(ws, { t: 'error', code: 'offline' });
    if (ws.sid) endSession(ws.sid, 'viewer-reconnect', ws);
    const sid = crypto.randomBytes(12).toString('hex');
    ws.role = 'viewer';
    ws.sid = sid;
    sessions.set(sid, { host, viewer: ws });
    send(host, { t: 'session-request', sid, from: ws.ip, iceServers: ICE_SERVERS });
    send(ws, { t: 'session-pending', sid, iceServers: ICE_SERVERS });
    log('連線要求來自', ws.ip);
  }

  function relay(ws, msg) {
    const s = sessions.get(msg.sid);
    if (!s) return;
    let peer;
    if (ws === s.host && HOST_SENDS.has(msg.t)) peer = s.viewer;
    else if (ws === s.viewer && VIEWER_SENDS.has(msg.t)) peer = s.host;
    else return;
    if (msg.t === 'bye') return endSession(msg.sid, msg.reason || 'closed', ws);
    send(peer, msg);
  }

  wss.on('connection', (ws, req) => {
    ws.ip = normIp(req.socket.remoteAddress);
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
          return hostHello(ws);
        case 'viewer-connect':
          return viewerConnect(ws);
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
        if (host === ws) host = null;
        for (const [sid, s] of sessions) if (s.host === ws) endSession(sid, 'host-offline', ws);
      } else if (ws.role === 'viewer' && ws.sid) {
        endSession(ws.sid, 'viewer-left', ws);
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [ip, arr] of rate) if (!arr.some((t) => now - t < 60000)) rate.delete(ip);
  }, 25000);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 不指定 bind 時同時監聽 IPv4 / IPv6 的所有介面，再用 allowed() 擋掉非 Tailscale 的來源
    server.listen(port, bind, () => {
      server.off('error', reject);
      resolve({
        port,
        close() {
          clearInterval(heartbeat);
          wss.close();
          server.close();
        },
      });
    });
  });
}

module.exports = { startSignaling, DEFAULT_PORT, isTailscale };
