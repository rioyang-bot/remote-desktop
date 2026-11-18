/* 遠端桌面控制端（瀏覽器） */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const QUALITY = {
    speed: { fps: 30, bitrate: 3000 },
    balanced: { fps: 60, bitrate: 8000 },
    quality: { fps: 60, bitrate: 15000 },
    lan: { fps: 60, bitrate: 40000 },
  };
  const ERRORS = {
    offline: '對方不在線上，請確認 ID 是否正確、被控端是否已開啟',
    'rate-limited': '嘗試次數太多，請稍候一分鐘再試',
    'wrong-password': '密碼錯誤',
    locked: '密碼錯誤次數過多，對方已暫時鎖定，請稍後再試',
    busy: '對方正在被其他人控制中',
    'host-offline': '對方已離線',
    'host-ended': '對方已中斷連線',
    'viewer-left': '連線已結束',
    'ice-failed': '無法建立連線（網路被阻擋，可能需要設定 TURN 伺服器）',
    timeout: '連線逾時',
    'host-error': '對方無法擷取畫面',
    unreachable: '連不到對方電腦：請確認對方已開機、RD Host 有在執行，而且兩台都連上 Tailscale',
  };

  let ws = null;
  let sid = null;
  let pc = null;
  let ctrl = null; // 可靠的資料通道（按鍵、點擊）
  let move = null; // 不可靠的資料通道（滑鼠移動，丟包不重送以降低延遲）
  let password = '';
  let codec = 'H264';
  let statsTimer = null;
  let connectTimer = null;
  let lastStats = null;
  const pressedKeys = new Set();
  const pressedButtons = new Set();

  /* ---------------- 連線畫面 ---------------- */
  const idInput = $('in-id');
  idInput.value = localStorage.getItem('rd.lastId') || '';
  idInput.addEventListener('input', () => {
    const d = idInput.value.replace(/\D/g, '').slice(0, 9);
    idInput.value = d.replace(/(\d{3})(?=\d)/g, '$1 ');
  });
  // 密碼欄位旁的眼睛：切換顯示 / 隱藏
  const pwInput = $('in-pw');
  const pwEye = $('pw-eye');
  function setPwVisible(show) {
    pwInput.type = show ? 'text' : 'password';
    pwEye.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/>
      <circle cx="12" cy="12" r="3"/>${show ? '<line x1="3" y1="3" x2="21" y2="21"/>' : ''}</svg>`;
    pwEye.title = show ? '隱藏密碼' : '顯示密碼';
    pwEye.setAttribute('aria-label', pwEye.title);
    pwEye.setAttribute('aria-pressed', String(show));
  }
  setPwVisible(false);
  pwEye.addEventListener('click', (e) => {
    e.preventDefault(); // 在 <label> 裡，避免點擊被轉給輸入框
    setPwVisible(pwInput.type === 'password');
    pwInput.focus();
  });

  const params = new URLSearchParams(location.search);
  if (params.get('id')) idInput.value = params.get('id');

  // 在 RD Host 程式的遠端視窗裡開啟時（直連模式）：
  // 程式帶入對方名稱、連線位址和密碼，直接連到對方電腦內建的信令伺服器
  const desktopApp = window.rdViewer || null;
  let appTarget = null; // { name, wsUrl }
  if (desktopApp) {
    desktopApp.take().then((c) => {
      if (!c || !c.wsUrl) return;
      appTarget = { name: c.name, wsUrl: c.wsUrl };
      idInput.value = c.name;
      idInput.readOnly = true;
      idInput.removeAttribute('required');
      idInput.closest('label').firstChild.textContent = '對方電腦';
      document.querySelector('#connect-form .muted').textContent = '輸入對方 RD Host 上的密碼';
      if (c.password) {
        $('in-pw').value = c.password;
        $('connect-form').requestSubmit();
      } else {
        $('in-pw').focus();
      }
    }).catch(() => {});
  }

  $('connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (appTarget) {
      password = $('in-pw').value;
      codec = $('in-codec').value;
      setPwVisible(false);
      return start('local', appTarget.wsUrl, appTarget.name);
    }
    const id = idInput.value.replace(/\D/g, '');
    if (id.length !== 9) return setStatus('ID 應為 9 位數字', true);
    password = $('in-pw').value;
    codec = $('in-codec').value;
    setPwVisible(false);
    try { localStorage.setItem('rd.lastId', idInput.value); } catch {}
    start(id);
  });

  function setStatus(text, isErr) {
    const el = $('connect-status');
    el.textContent = text;
    el.classList.toggle('err', !!isErr);
  }

  /**
   * @param {string} id 對方 ID（直連模式固定為 'local'）
   * @param {string} [wsUrl] 直連模式：對方電腦的信令位址；省略時用網頁所在的伺服器
   * @param {string} [label] 畫面上顯示的名稱
   */
  function start(id, wsUrl, label) {
    cleanup();
    $('btn-connect').disabled = true;
    setStatus(wsUrl ? '連線到對方電腦…' : '連線到伺服器…');
    const url = wsUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const sock = new WebSocket(url);
    ws = sock;
    let opened = false;
    sock.onopen = () => {
      opened = true;
      setStatus('尋找對方…');
      wsSend({ t: 'viewer-connect', id });
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onSignal(msg, label || id);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      if (!opened) fail(wsUrl ? ERRORS.unreachable : '無法連到伺服器');
      else if (sid && !pc) fail('與伺服器的連線中斷');
      ws = null;
    };
    ws.onerror = () => {};
    connectTimer = setTimeout(() => fail(ERRORS.timeout), 30000);
  }

  function wsSend(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  async function onSignal(msg, id) {
    switch (msg.t) {
      case 'error':
        return fail(ERRORS[msg.code] || msg.code);
      case 'session-pending':
        sid = msg.sid;
        iceServers = msg.iceServers || [];
        setStatus('驗證密碼…');
        return;
      case 'challenge':
        if (msg.sid !== sid) return;
        wsSend({ t: 'auth', sid, proof: RDHash.makeProof(password, msg.salt, msg.nonce), codec });
        return;
      case 'auth-result':
        if (msg.sid !== sid) return;
        if (!msg.ok) return fail(ERRORS[msg.reason] || '驗證失敗');
        if (desktopApp && desktopApp.authOk) desktopApp.authOk(password);
        password = '';
        $('in-pw').value = '';
        setStatus('建立連線…');
        createPeer(id);
        return;
      case 'signal':
        if (msg.sid !== sid || !pc) return;
        return handleRemoteSignal(msg.data || {});
      case 'bye':
        if (msg.sid !== sid) return;
        return fail(ERRORS[msg.reason] || '連線已結束');
    }
  }

  let iceServers = [];
  const pendingCandidates = [];

  /* Tailscale 位址：100.64.0.0/10、fd7a:115c:a1e0::/48 */
  function isTailscaleAddr(addr) {
    const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(addr);
    if (m) return +m[1] === 100 && (+m[2] & 0xc0) === 64;
    return addr.toLowerCase().startsWith('fd7a:115c:a1e0:');
  }

  /**
   * 把 Tailscale 位址的 ICE 候選降到「比打洞直連低、比 TURN 中繼高」的優先順序。
   * 兩台不在同一個網路時，Tailscale 可能繞道它的中繼伺服器（DERP），頻寬小又延遲高；
   * 先讓 WebRTC 自己打洞直連，打不通才走 Tailscale。（被控端 host.js 也做一樣的事）
   */
  function demoteTailscale(c) {
    if (!c || !c.candidate) return c;
    const parts = c.candidate.split(' ');
    if (parts.length < 8 || !isTailscaleAddr(parts[4])) return c;
    const prio = Number(parts[3]);
    if (!Number.isFinite(prio)) return c;
    parts[3] = String(50 * 2 ** 24 + (prio % 2 ** 24));
    return { ...c, candidate: parts.join(' ') };
  }

  function createPeer(id) {
    pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    pc.onicecandidate = (e) => {
      if (e.candidate) wsSend({ t: 'signal', sid, data: { candidate: demoteTailscale(e.candidate.toJSON()) } });
    };
    pc.ontrack = (e) => {
      const video = $('remote');
      video.srcObject = e.streams[0] || new MediaStream([e.track]);
      // 最低延遲：不要額外的播放緩衝
      try { e.receiver.jitterBufferTarget = 0; } catch {}
      try { e.receiver.playoutDelayHint = 0; } catch {}
      video.play().catch(() => {});
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === 'ctrl') {
        ctrl = ch;
        ch.onmessage = (ev) => onCtrlMessage(ev.data);
        ch.onopen = () => sendQuality();
      } else if (ch.label === 'move') {
        move = ch;
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc && pc.connectionState;
      if (s === 'connected') {
        clearTimeout(connectTimer);
        showSession(id);
      } else if (s === 'failed') {
        fail(ERRORS['ice-failed']);
      } else if (s === 'disconnected') {
        showOverlay('網路不穩，重新連線中…');
      }
    };
  }

  async function handleRemoteSignal(data) {
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        for (const c of pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          wsSend({ t: 'signal', sid, data: { sdp: pc.localDescription.toJSON() } });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else pendingCandidates.push(data.candidate);
      }
    } catch (err) {
      console.error(err);
      fail('建立連線失敗：' + err.message);
    }
  }

  function fail(text) {
    const wasInSession = !$('session-view').hidden;
    cleanup();
    $('session-view').hidden = true;
    $('connect-view').hidden = false;
    setStatus(text, true);
    if (wasInSession && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  function cleanup() {
    clearTimeout(connectTimer);
    clearInterval(statsTimer);
    statsTimer = null;
    releaseAll();
    if (sid && ws) wsSend({ t: 'bye', sid, reason: 'viewer-left' });
    if (pc) pc.close();
    if (ws) ws.close();
    pc = ctrl = move = ws = null;
    sid = null;
    lastStats = null;
    pendingCandidates.length = 0;
    $('remote').srcObject = null;
    $('btn-connect').disabled = false;
    hideOverlay();
  }

  /* ---------------- 遠端畫面 ---------------- */
  function showSession(id) {
    hideOverlay();
    if (!$('session-view').hidden) return;
    $('connect-view').hidden = true;
    $('session-view').hidden = false;
    $('tb-title').textContent = /^\d{9}$/.test(id) ? id.replace(/(\d{3})(?=\d)/g, '$1 ') : id;
    setStatus('');
    $('remote').focus();
    if (desktopApp && desktopApp.connected) desktopApp.connected();
    const tb = $('toolbar');
    tb.classList.add('show');
    setTimeout(() => tb.classList.remove('show'), 2500);
  }

  function showOverlay(text) {
    const o = $('overlay');
    o.textContent = text;
    o.hidden = false;
  }
  function hideOverlay() { $('overlay').hidden = true; }

  function onCtrlMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'displays') {
      const sel = $('tb-display');
      sel.innerHTML = '';
      for (const d of msg.list) {
        const o = document.createElement('option');
        o.value = d.id;
        o.textContent = `${d.name}（${d.w}×${d.h}）`;
        if (d.id === msg.current) o.selected = true;
        sel.appendChild(o);
      }
    } else if (msg.t === 'clip' && typeof msg.text === 'string') {
      // 對方複製了文字 → 寫到本機剪貼簿（需要頁面有焦點，失敗就算了）
      navigator.clipboard?.writeText(msg.text).catch(() => {});
    }
  }

  function sendCtrl(obj) {
    if (ctrl && ctrl.readyState === 'open') ctrl.send(JSON.stringify(obj));
  }
  function sendMove(obj) {
    if (move && move.readyState === 'open' && move.bufferedAmount < 16384) move.send(JSON.stringify(obj));
    else sendCtrl(obj);
  }
  function sendQuality() {
    const q = QUALITY[$('tb-quality').value] || QUALITY.balanced;
    sendCtrl({ t: 'quality', fps: q.fps, bitrate: q.bitrate, mode: $('tb-mode').value });
  }

  $('tb-quality').addEventListener('change', sendQuality);
  $('tb-mode').addEventListener('change', sendQuality);
  $('tb-display').addEventListener('change', (e) => sendCtrl({ t: 'display', id: e.target.value }));
  $('tb-end').addEventListener('click', () => {
    fail('已中斷連線');
    if (desktopApp) desktopApp.close(); // 程式的遠端視窗：中斷後直接關閉視窗
  });
  $('tb-full').addEventListener('click', toggleFullscreen);
  $('tb-stats').addEventListener('click', () => {
    const el = $('stats');
    el.hidden = !el.hidden;
    if (!el.hidden && !statsTimer) statsTimer = setInterval(updateStats, 1000);
    if (el.hidden) { clearInterval(statsTimer); statsTimer = null; }
  });
  $('hotzone').addEventListener('mouseenter', () => $('toolbar').classList.add('show'));
  $('toolbar').addEventListener('mouseleave', () => $('toolbar').classList.remove('show'));
  // 工具列的選單變更後把焦點還給畫面，避免按鍵被選單吃掉
  for (const el of $('toolbar').querySelectorAll('select')) {
    el.addEventListener('change', () => $('remote').focus());
  }

  async function toggleFullscreen() {
    if (document.fullscreenElement) {
      navigator.keyboard?.unlock?.();
      await document.exitFullscreen().catch(() => {});
    } else {
      await $('session-view').requestFullscreen().catch(() => {});
      // 全螢幕時鎖定鍵盤，讓 Win、Alt+Tab、Esc 等也能送到遠端（長按 Esc 可離開）
      await navigator.keyboard?.lock?.().catch(() => {});
    }
    $('remote').focus();
  }

  /* ---------------- 滑鼠 ---------------- */
  const video = $('remote');
  video.tabIndex = 0;

  /** 把滑鼠座標換算成遠端畫面上的 0~1 座標（扣掉 object-fit: contain 的黑邊） */
  function toRemote(e) {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(r.width / vw, r.height / vh);
    const w = vw * scale, h = vh * scale;
    const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
    const x = (e.clientX - ox) / w, y = (e.clientY - oy) / h;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
  }

  let pendingMove = null;
  let moveScheduled = false;
  video.addEventListener('pointermove', (e) => {
    const p = toRemote(e);
    if (!p) return;
    pendingMove = p;
    if (!moveScheduled) {
      moveScheduled = true;
      // 每一幀最多送一次，避免高回報率滑鼠塞爆通道
      requestAnimationFrame(() => {
        moveScheduled = false;
        if (pendingMove) sendMove({ t: 'mm', x: pendingMove.x, y: pendingMove.y });
        pendingMove = null;
      });
    }
  });

  const BTN = ['l', 'm', 'r', 'x1', 'x2'];
  video.addEventListener('pointerdown', (e) => {
    const p = toRemote(e);
    const b = BTN[e.button];
    if (!p || !b) return;
    if (!p.inside) return;
    e.preventDefault();
    video.focus();
    video.setPointerCapture(e.pointerId);
    pressedButtons.add(b);
    sendCtrl({ t: 'md', b, x: p.x, y: p.y });
  });
  video.addEventListener('pointerup', (e) => {
    const p = toRemote(e);
    const b = BTN[e.button];
    if (!p || !b || !pressedButtons.has(b)) return;
    e.preventDefault();
    pressedButtons.delete(b);
    sendCtrl({ t: 'mu', b, x: p.x, y: p.y });
  });
  video.addEventListener('contextmenu', (e) => e.preventDefault());
  video.addEventListener('auxclick', (e) => e.preventDefault());

  let wheelAcc = { x: 0, y: 0 };
  video.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    // 瀏覽器每格約 100px，Windows 每格是 120
    wheelAcc.y += -e.deltaY * k * 1.2;
    wheelAcc.x += e.deltaX * k * 1.2;
    const dy = Math.trunc(wheelAcc.y), dx = Math.trunc(wheelAcc.x);
    if (dy || dx) {
      wheelAcc.y -= dy;
      wheelAcc.x -= dx;
      sendCtrl({ t: 'wh', dx, dy });
    }
  }, { passive: false });

  /* ---------------- 鍵盤 ---------------- */
  function sessionActive() {
    return !$('session-view').hidden && ctrl && ctrl.readyState === 'open';
  }
  function isToolbarFocused() {
    const a = document.activeElement;
    return a && $('toolbar').contains(a);
  }

  document.addEventListener('keydown', async (e) => {
    if (!sessionActive() || isToolbarFocused()) return;
    if (!e.code) return;
    e.preventDefault();
    // Ctrl+V：先把本機剪貼簿同步過去，再送出按鍵
    if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey) && !e.repeat && navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text && text.length <= 1_000_000) sendCtrl({ t: 'clip', text });
      } catch {}
    }
    pressedKeys.add(e.code);
    sendCtrl({ t: 'kd', code: e.code });
  }, true);

  document.addEventListener('keyup', (e) => {
    if (!sessionActive() || !pressedKeys.has(e.code)) return;
    e.preventDefault();
    pressedKeys.delete(e.code);
    sendCtrl({ t: 'ku', code: e.code });
  }, true);

  // 切換視窗時放開所有按鍵，避免 Ctrl/Alt 卡住
  function releaseAll() {
    if (pressedKeys.size || pressedButtons.size) sendCtrl({ t: 'release-all' });
    pressedKeys.clear();
    pressedButtons.clear();
  }
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  window.addEventListener('beforeunload', () => cleanup());

  /* ---------------- 統計 ---------------- */
  async function updateStats() {
    if (!pc) return;
    const report = await pc.getStats();
    let inb, pair, local, codecName = '';
    const byId = new Map();
    report.forEach((s) => byId.set(s.id, s));
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s;
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
    });
    if (!pair) report.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
    if (pair) local = byId.get(pair.localCandidateId);
    if (inb && inb.codecId && byId.get(inb.codecId)) codecName = byId.get(inb.codecId).mimeType.replace('video/', '');
    const lines = [];
    if (inb) {
      const now = inb.timestamp;
      let kbps = 0;
      if (lastStats) kbps = ((inb.bytesReceived - lastStats.bytes) * 8) / (now - lastStats.ts);
      const jb = inb.jitterBufferEmittedCount ? (inb.jitterBufferDelay / inb.jitterBufferEmittedCount) * 1000 : 0;
      const dec = inb.framesDecoded ? (inb.totalDecodeTime / inb.framesDecoded) * 1000 : 0;
      lastStats = { bytes: inb.bytesReceived, ts: now };
      lines.push(`畫面   ${inb.frameWidth || '-'}×${inb.frameHeight || '-'} @ ${Math.round(inb.framesPerSecond || 0)} fps`);
      lines.push(`編碼   ${codecName}${inb.decoderImplementation ? ' / ' + inb.decoderImplementation : ''}`);
      lines.push(`流量   ${(kbps / 1000).toFixed(1)} Mbps`);
      lines.push(`緩衝   ${jb.toFixed(0)} ms   解碼 ${dec.toFixed(1)} ms`);
      lines.push(`掉包   ${inb.packetsLost || 0}`);
    }
    if (pair) {
      lines.push(`往返   ${pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) + ' ms' : '-'}`);
    }
    if (local) {
      const path = local.candidateType === 'relay' ? '中繼（TURN）'
        : isTailscaleAddr(local.address || '') ? '經 Tailscale（不同網路時可能繞道中繼，較慢）'
        : '直連（P2P）';
      lines.push(`路徑   ${path}`);
    }
    $('stats').textContent = lines.join('\n');
  }
})();
