/* 被控端畫面視窗：信令連線 + WebRTC 擷取與傳送畫面 */
'use strict';
/* global rd -- 由 preload.js 透過 contextBridge 提供 */
const $ = (id) => document.getElementById(id);

const DEFAULT_QUALITY = { fps: 60, bitrate: 8000, mode: 'detail' };
const CODECS = { H264: 'video/h264', VP8: 'video/vp8', VP9: 'video/vp9', AV1: 'video/av1' };
const CONNECT_TIMEOUT_MS = 30000;

let ws = null;
let backoff = 1000;
let reconnectTimer = null;
let st = null; // 主程序狀態
const pending = new Map(); // sid -> { from, iceServers }
let session = null;

/* ---------------- 紀錄 ---------------- */
function log(...args) {
  const line = `${new Date().toLocaleTimeString()}  ${args.join(' ')}`;
  console.log(line);
  const el = $('log');
  el.textContent = (line + '\n' + el.textContent).split('\n').slice(0, 200).join('\n');
}

function setStatus(text, kind) {
  $('status').textContent = text;
  $('dot').className = 'dot ' + (kind || '');
}

const fmtId = (id) => (id ? String(id).replace(/(\d{3})(?=\d)/g, '$1 ') : '— — —');

/* ---------------- 初始化 ---------------- */
let ready = false; // 畫面視窗已向本機信令伺服器註冊
let tsInfo = null; // Tailscale 狀態

/* ---------------- 密碼顯示：預設 ********，按眼睛切換 ---------------- */
const MASK = '********';
const SVG_EYE = '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>';
const SVG_SLASH = '<line x1="3" y1="3" x2="21" y2="21"/>';

/** 更新眼睛按鈕：revealed = 目前是否顯示明文（顯示時圖示加上斜線，代表「按下可隱藏」） */
function setEye(btn, revealed) {
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG_EYE}${revealed ? SVG_SLASH : ''}</svg>`;
  btn.title = revealed ? '隱藏密碼' : '顯示密碼';
  btn.setAttribute('aria-label', btn.title);
  btn.setAttribute('aria-pressed', String(revealed));
}

/** 密碼輸入欄位旁的眼睛：切換 type=password / text */
function initInputEyes() {
  for (const btn of document.querySelectorAll('.eye.in-input')) {
    const input = $(btn.dataset.for);
    setEye(btn, false);
    btn.onclick = () => {
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      setEye(btn, reveal);
      input.focus();
    };
    // 送出表單後恢復成隱藏
    input.form && input.form.addEventListener('submit', () => {
      input.type = 'password';
      setEye(btn, false);
    });
  }
}

let otp = '';
let otpShown = false;
function renderOtp() {
  $('otp').textContent = otpShown ? otp : MASK;
  setEye($('otp-eye'), otpShown);
}

let permShown = false;
async function renderPerm() {
  const has = st.hasPermanent;
  const canReveal = has && st.permRevealable;
  $('perm-eye').hidden = !canReveal;
  $('clear-perm').hidden = !has;
  if (!has) permShown = false;
  $('perm-show').textContent = !has ? '尚未設定' : permShown && canReveal ? await rd.getPermanentPassword() : MASK;
  if (canReveal) setEye($('perm-eye'), permShown);
  $('perm-state').textContent = has && !canReveal
    ? '這組固定密碼是舊版設定的，無法顯示。重新設定一次之後，就能按眼睛查看。'
    : '';
}

async function init() {
  st = await rd.getState();
  otp = st.otp;
  renderOtp();
  $('auto-start').checked = st.autoStart;
  $('version').textContent = `版本 ${st.version}`;
  initInputEyes();
  renderPerm();

  $('copy-name').onclick = () => tsInfo && tsInfo.self && rd.copyText(tsInfo.self.name);
  $('otp-eye').onclick = () => {
    otpShown = !otpShown;
    renderOtp();
  };
  $('copy-otp').onclick = () => rd.copyText(otp);
  $('refresh-otp').onclick = async () => {
    otp = await rd.refreshOtp();
    renderOtp();
  };
  $('end-session').onclick = () => endSession('host-ended');
  rd.onForceDisconnect(() => endSession('host-ended'));

  $('perm-eye').onclick = () => {
    permShown = !permShown;
    renderPerm();
  };
  $('perm-form').onsubmit = async (e) => {
    e.preventDefault();
    const r = await rd.setPermanentPassword($('perm-pw').value);
    if (!r.ok) return alert(r.reason);
    $('perm-pw').value = '';
    st = await rd.getState();
    permShown = false;
    renderPerm();
  };
  $('clear-perm').onclick = async () => {
    if (!confirm('要清除固定密碼嗎？清除後只能用一次性密碼連線。')) return;
    await rd.setPermanentPassword(null);
    st = await rd.getState();
    renderPerm();
  };
  $('auto-start').onchange = (e) => rd.setAutoStart(e.target.checked);

  initConnectTo();
  if (st.signalError) {
    setStatus('無法啟動：' + st.signalError, 'err');
    log('內建信令伺服器啟動失敗：', st.signalError);
    return;
  }
  connect();
}

/** 依「本機註冊狀態 + Tailscale 狀態」更新上方的狀態列 */
function updateStatus() {
  if (session) return setStatus('遠端控制中', 'live');
  if (!ready) return setStatus('啟動中…');
  if (!tsInfo || tsInfo.tailscale !== 'running') return setStatus('Tailscale 未連線，其他電腦連不到這台', 'err');
  setStatus('已就緒，等待連線', 'ok');
}

/* ---------------- 本機資訊與電腦清單 ---------------- */
async function refreshComputers() {
  let r;
  try {
    r = await rd.listComputers();
  } catch {
    return;
  }
  tsInfo = r;
  $('my-name').textContent = r.self ? r.self.name : '—';
  $('my-ip').textContent = r.self ? `Tailscale IP：${r.self.ip}` : '';
  const warn = $('ts-warn');
  warn.hidden = r.tailscale === 'running';
  warn.textContent = r.tailscale === 'not-installed'
    ? '這台還沒安裝 Tailscale。請先安裝並登入，其他電腦才連得到。'
    : 'Tailscale 沒有連線。請從系統匣開啟 Tailscale 並登入。';
  renderComputers(r.computers);
  updateStatus();
}

function renderComputers(list) {
  const ul = $('pc-list');
  ul.textContent = '';
  $('pc-empty').hidden = list.length > 0 || !tsInfo || tsInfo.tailscale !== 'running';
  for (const c of list) {
    const li = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'fav-go';
    const dot = document.createElement('span');
    dot.className = 'dot ' + (c.online === false ? 'off' : c.online ? 'ok' : '');
    dot.title = c.online === false ? '離線' : c.online ? '在線上' : '';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = c.name;
    const ip = document.createElement('span');
    ip.className = 'id mono';
    ip.textContent = c.ip;
    go.append(dot, name, ip);
    if (!c.hasPassword) {
      const lock = document.createElement('span');
      lock.className = 'lock';
      lock.textContent = '需密碼';
      go.append(lock);
    }
    go.title = c.online === false ? '這台目前離線' : c.hasPassword ? '連線' : '連線（需要輸入密碼）';
    go.onclick = () => {
      if (c.hasPassword) return connectTo({ target: c.name });
      // 沒有記住密碼 → 填好名稱，請使用者輸入密碼
      $('c-target').value = c.name;
      $('c-pw').value = '';
      $('c-pw').focus();
      $('c-msg').textContent = `請輸入「${c.name}」的密碼`;
    };
    li.append(go);
    if (c.saved) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost fav-del';
      del.title = c.inTailnet ? '忘記密碼' : '從清單移除';
      del.textContent = '×';
      del.onclick = async () => {
        const what = c.inTailnet ? `忘記「${c.name}」的密碼` : `從清單移除「${c.name}」`;
        if (!confirm(`要${what}嗎？`)) return;
        await rd.forgetComputer(c.name);
        refreshComputers();
      };
      li.append(del);
    }
    ul.append(li);
  }
}

async function connectTo(req) {
  const r = await rd.connectTo(req);
  if (!r.ok) {
    $('c-msg').textContent = r.reason;
    return false;
  }
  $('c-msg').textContent = '';
  refreshComputers();
  return true;
}

function initConnectTo() {
  $('connect-form').onsubmit = async (e) => {
    e.preventDefault();
    const ok = await connectTo({
      target: $('c-target').value,
      password: $('c-pw').value,
      remember: $('c-remember').checked,
    });
    if (ok) {
      $('c-target').value = '';
      $('c-pw').value = '';
    }
  };
  refreshComputers();
  rd.onComputersChanged(refreshComputers);
  // 定時更新（其他電腦上線/離線）
  setInterval(() => {
    if (!document.hidden) refreshComputers();
  }, 10000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshComputers();
  });
}

/* ---------------- 信令 ---------------- */
function connect() {
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  ready = false;
  updateStatus();
  const url = st.serverUrl;
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    setStatus('內部錯誤：' + e.message, 'err');
    return;
  }
  ws = sock;
  sock.onopen = async () => {
    backoff = 1000;
    const ident = await rd.getIdentity();
    send({ t: 'host-hello', id: ident.id, secret: ident.secret });
  };
  sock.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    onSignal(msg).catch((e) => log('錯誤', e.message));
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    ready = false;
    setStatus(`內部連線中斷，${Math.round(backoff / 1000)} 秒後重試`, 'err');
    reconnect(backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
}

function reconnect(delay) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

// 定時 ping，避免中間的代理伺服器把閒置連線切掉
setInterval(() => send({ t: 'ping' }), 20000);

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

async function onSignal(msg) {
  switch (msg.t) {
    case 'host-ok':
      ready = true;
      updateStatus();
      log('已啟動，等待其他電腦連線');
      return;

    case 'replaced':
      log('同一個 ID 在別處登入，此連線被取代');
      return;

    case 'session-request': {
      log('收到連線要求，來自', msg.from);
      pending.set(msg.sid, { from: msg.from, iceServers: msg.iceServers || [] });
      setTimeout(() => pending.delete(msg.sid), 60000);
      const ch = await rd.newChallenge(msg.sid);
      send({ t: 'challenge', sid: msg.sid, nonce: ch.nonce, salt: ch.salt });
      return;
    }

    case 'auth': {
      const info = pending.get(msg.sid);
      if (!info) return;
      pending.delete(msg.sid);
      let result = await rd.verify(msg.sid, msg.proof);
      if (result.ok && session) result = { ok: false, reason: 'busy' };
      send({ t: 'auth-result', sid: msg.sid, ok: result.ok, reason: result.reason });
      if (!result.ok) {
        log('驗證失敗：', result.reason, '來自', info.from);
        send({ t: 'bye', sid: msg.sid, reason: result.reason });
        return;
      }
      log(`驗證成功（${result.kind === 'permanent' ? '固定密碼' : '一次性密碼'}）`);
      try {
        await startSession(msg.sid, info, CODECS[msg.codec] ? msg.codec : 'H264');
      } catch (e) {
        log('無法開始傳送畫面：', e.message);
        if (session && session.sid === msg.sid) endSession('host-error');
        else send({ t: 'bye', sid: msg.sid, reason: 'host-error' });
      }
      return;
    }

    case 'signal':
      if (session && session.sid === msg.sid) await onPeerSignal(msg.data || {});
      return;

    case 'bye':
      if (session && session.sid === msg.sid) {
        log('對方已中斷');
        endSession(null);
      }
      return;
  }
}

/* ---------------- 擷取畫面 ---------------- */
async function capture(display, fps) {
  if (!display.sourceId) throw new Error('找不到螢幕擷取來源');
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: display.sourceId,
        maxWidth: display.w,
        maxHeight: display.h,
        maxFrameRate: fps,
      },
    },
  });
}

function preferCodec(transceiver, name) {
  const want = CODECS[name];
  for (const getCaps of [() => RTCRtpReceiver.getCapabilities('video'), () => RTCRtpSender.getCapabilities('video')]) {
    try {
      const codecs = getCaps().codecs;
      let pref = codecs.filter((c) => c.mimeType.toLowerCase() === want);
      if (!pref.length) return;
      // H.264 優先用 packetization-mode=1（硬體編碼器最相容）
      if (name === 'H264') {
        pref.sort((a, b) => /packetization-mode=1/.test(b.sdpFmtpLine || '') - /packetization-mode=1/.test(a.sdpFmtpLine || ''));
      }
      transceiver.setCodecPreferences([...pref, ...codecs.filter((c) => !pref.includes(c))]);
      return;
    } catch (e) {
      log('設定編碼偏好失敗，改用下一種方式', e.message);
    }
  }
}

/** 在對方的 answer 加上起始位元率，避免連線剛建立時畫面糊好幾秒 */
function withStartBitrate(sdp, kbps) {
  try {
    const lines = sdp.split('\r\n');
    const video = new Set();
    let inVideo = false;
    for (const l of lines) {
      if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
      const m = inVideo && /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i.exec(l);
      if (m) video.add(m[1]);
    }
    const extra = `x-google-start-bitrate=${kbps}`;
    const hasFmtp = new Set();
    let out = lines.map((l) => {
      const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
      if (m && video.has(m[1]) && !/x-google-start-bitrate/.test(l)) {
        hasFmtp.add(m[1]);
        return `${l};${extra}`;
      }
      return l;
    });
    out = out.flatMap((l) => {
      const m = /^a=rtpmap:(\d+) /.exec(l);
      return m && video.has(m[1]) && !hasFmtp.has(m[1]) ? [l, `a=fmtp:${m[1]} ${extra}`] : [l];
    });
    return out.join('\r\n');
  } catch {
    return sdp;
  }
}

/* ---------------- 工作階段 ---------------- */
async function startSession(sid, info, codec) {
  const displays = await rd.getDisplays();
  const display = displays.find((d) => d.primary) || displays[0];
  if (!display) throw new Error('找不到螢幕');

  const quality = { ...DEFAULT_QUALITY };
  const stream = await capture(display, 60);
  const track = stream.getVideoTracks()[0];
  track.contentHint = 'detail';
  await rd.setActiveDisplay(display);

  const pc = new RTCPeerConnection({ iceServers: info.iceServers, bundlePolicy: 'max-bundle' });
  session = {
    sid, pc, stream, track, display, displays, quality, from: info.from, codec,
    connected: false, clipTimer: null, lastClip: null,
    timer: setTimeout(() => {
      if (session && session.sid === sid && !session.connected) {
        log('連線逾時（網路無法打通，可能需要 TURN）');
        endSession('timeout');
      }
    }, CONNECT_TIMEOUT_MS),
  };

  const ctrl = pc.createDataChannel('ctrl', { ordered: true });
  const move = pc.createDataChannel('move', { ordered: false, maxRetransmits: 0 });
  session.ctrl = ctrl;
  ctrl.onmessage = (e) => onCtrl(e.data);
  move.onmessage = (e) => onCtrl(e.data);
  ctrl.onopen = () => sendDisplays();

  const transceiver = pc.addTransceiver(track, {
    direction: 'sendonly',
    streams: [stream],
    sendEncodings: [{ maxBitrate: quality.bitrate * 1000, maxFramerate: quality.fps }],
  });
  session.sender = transceiver.sender;
  preferCodec(transceiver, codec);

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ t: 'signal', sid, data: { candidate: demoteTailscale(e.candidate.toJSON()) } });
  };
  pc.onconnectionstatechange = () => {
    if (!session || session.pc !== pc) return;
    const s = pc.connectionState;
    log('連線狀態', s);
    if (s === 'connected' && !session.connected) {
      session.connected = true;
      clearTimeout(session.timer);
      onConnected();
    } else if (s === 'failed') {
      endSession('ice-failed');
    }
  };

  await pc.setLocalDescription(await pc.createOffer());
  send({ t: 'signal', sid, data: { sdp: pc.localDescription.toJSON() } });
  await applyQuality(quality);
}

async function onPeerSignal(data) {
  const pc = session.pc;
  if (data.sdp && data.sdp.type === 'answer') {
    const startKbps = Math.min(session.quality.bitrate, 4000);
    await pc.setRemoteDescription({ type: 'answer', sdp: withStartBitrate(data.sdp.sdp, startKbps) });
  } else if (data.candidate) {
    await pc.addIceCandidate(data.candidate).catch((e) => log('ICE 候選錯誤', e.message));
  }
}

function onConnected() {
  log('已建立連線，開始傳送畫面');
  setStatus('遠端控制中', 'live');
  $('session-card').hidden = false;
  $('session-info').textContent = session.from || '';
  rd.sessionStarted({ from: session.from });
  logPath();
  // 剪貼簿：被控端複製的文字自動送到控制端
  rd.readClipboard().then((t) => session && (session.lastClip = t));
  session.clipTimer = setInterval(async () => {
    if (!session) return;
    const t = await rd.readClipboard();
    if (t !== session.lastClip) {
      session.lastClip = t;
      if (t && t.length <= 1_000_000) sendCtrl({ t: 'clip', text: t });
    }
  }, 1000);
}

async function logPath() {
  try {
    const report = await session.pc.getStats();
    let pairId;
    report.forEach((s) => s.type === 'transport' && s.selectedCandidatePairId && (pairId = s.selectedCandidatePairId));
    const pair = pairId && report.get(pairId);
    const local = pair && report.get(pair.localCandidateId);
    if (local) {
      const viaTs = isTailscaleAddr(local.address || '');
      log('連線路徑', local.candidateType === 'relay' ? '中繼（TURN）' : viaTs ? '經 Tailscale' : '直連（P2P）', local.protocol || '');
    }
  } catch {}
}

/* ---------------- 連線路徑偏好 ---------------- */
// Tailscale 位址：100.64.0.0/10、fd7a:115c:a1e0::/48
function isTailscaleAddr(addr) {
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(addr);
  if (m) return +m[1] === 100 && (+m[2] & 0xc0) === 64;
  return addr.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

/**
 * 把 Tailscale 位址的 ICE 候選降到「比打洞直連低、比 TURN 中繼高」的優先順序。
 * 兩台不在同一個網路時，Tailscale 可能繞道它的中繼伺服器（DERP），頻寬小又延遲高；
 * 先讓 WebRTC 自己打洞直連，打不通才走 Tailscale。
 * 候選格式：candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
 */
function demoteTailscale(c) {
  if (!c || !c.candidate) return c;
  const parts = c.candidate.split(' ');
  if (parts.length < 8 || !isTailscaleAddr(parts[4])) return c;
  const prio = Number(parts[3]);
  if (!Number.isFinite(prio)) return c;
  // 類型偏好放在最高 8 位元：host=126、srflx=100、relay=0 → 改成 50
  parts[3] = String(50 * 2 ** 24 + (prio % 2 ** 24));
  return { ...c, candidate: parts.join(' ') };
}

function sendCtrl(obj) {
  if (session && session.ctrl && session.ctrl.readyState === 'open') session.ctrl.send(JSON.stringify(obj));
}

function sendDisplays() {
  if (!session) return;
  sendCtrl({
    t: 'displays',
    current: session.display.id,
    list: session.displays.map((d) => ({ id: d.id, name: d.name, w: d.w, h: d.h, primary: d.primary })),
  });
}

const INPUT_TYPES = new Set(['mm', 'md', 'mu', 'wh', 'kd', 'ku', 'release-all']);

function onCtrl(raw) {
  if (!session || !session.connected) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg.t !== 'string') return;
  if (INPUT_TYPES.has(msg.t)) return rd.input(msg);
  if (msg.t === 'quality') return applyQuality(msg).catch((e) => log('調整畫質失敗', e.message));
  if (msg.t === 'display') return switchDisplay(String(msg.id)).catch((e) => log('切換螢幕失敗', e.message));
  if (msg.t === 'clip' && typeof msg.text === 'string') {
    session.lastClip = msg.text; // 避免又被送回去
    return rd.writeClipboard(msg.text);
  }
}

async function applyQuality(q) {
  if (!session) return;
  const fps = Math.min(60, Math.max(5, q.fps | 0 || 60));
  const bitrate = Math.min(100000, Math.max(300, q.bitrate | 0 || 8000));
  const mode = q.mode === 'motion' ? 'motion' : 'detail';
  session.quality = { fps, bitrate, mode };
  session.track.contentHint = mode;
  const sender = session.sender;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) return;
  p.encodings[0].maxBitrate = bitrate * 1000;
  p.encodings[0].maxFramerate = fps;
  // 文字清晰：網路差時降幀率保解析度；動態流暢：降解析度保幀率
  p.degradationPreference = mode === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
  try {
    await sender.setParameters(p);
  } catch {
    // 某些版本不支援 degradationPreference → 只設位元率與幀率
    const p2 = sender.getParameters();
    if (p2.encodings && p2.encodings.length) {
      p2.encodings[0].maxBitrate = bitrate * 1000;
      p2.encodings[0].maxFramerate = fps;
      await sender.setParameters(p2).catch((e) => log('設定畫質失敗', e.message));
    }
  }
  log(`畫質：${fps}fps、${(bitrate / 1000).toFixed(1)} Mbps、${mode === 'motion' ? '動態流暢' : '文字清晰'}`);
}

async function switchDisplay(id) {
  if (!session || session.display.id === id) return;
  session.displays = await rd.getDisplays();
  const d = session.displays.find((x) => x.id === id);
  if (!d) return;
  const stream = await capture(d, 60);
  const track = stream.getVideoTracks()[0];
  track.contentHint = session.quality.mode;
  await session.sender.replaceTrack(track);
  session.stream.getTracks().forEach((t) => t.stop());
  session.stream = stream;
  session.track = track;
  session.display = d;
  await rd.setActiveDisplay(d);
  sendDisplays();
  log('切換到', d.name);
}

function endSession(reason) {
  if (!session) return;
  const s = session;
  session = null;
  clearTimeout(s.timer);
  clearInterval(s.clipTimer);
  if (reason) send({ t: 'bye', sid: s.sid, reason });
  try { s.pc.close(); } catch {}
  s.stream.getTracks().forEach((t) => t.stop());
  rd.sessionEnded();
  $('session-card').hidden = true;
  updateStatus();
  log('工作階段結束', reason || '');
}

init();
