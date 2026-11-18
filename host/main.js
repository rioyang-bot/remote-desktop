'use strict';
/**
 * 遠端桌面被控端 — Electron 主程序
 *
 *  主程序負責：設定檔、密碼驗證、螢幕清單、滑鼠鍵盤注入、系統匣、「遠端控制中」提示列
 *  畫面視窗 (renderer) 負責：信令連線、WebRTC 擷取與傳送畫面
 */
const path = require('path');
const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard, Tray, Menu, nativeImage, safeStorage,
  utilityProcess, MessageChannelMain,
} = require('electron');
const { Config } = require('./lib/config');
const { Auth } = require('./lib/auth');
const { circlePng } = require('./lib/icon');
const { startSignaling, DEFAULT_PORT: SIGNAL_PORT } = require('./lib/signaling');
const { getStatus: getTailscale } = require('./lib/tailscale');

// ---- 低延遲相關的 Chromium 參數 ----
// 視窗縮小或被遮住時不要降速，否則畫面會卡
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// 不要用 mDNS 隱藏區網 IP，讓同網段可以直接 P2P；關閉視窗遮蔽偵測避免擷取被節流
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion');

// 開發測試用：同一台電腦跑第二個 RD Host（另一個設定資料夾），例如一個當被控端、一個當控制端
if (process.env.RD_USER_DATA) app.setPath('userData', process.env.RD_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let banner = null;
let tray = null;
let quitting = false;
let config;
let auth;
let signalError = null; // 內建信令伺服器啟動失敗的原因
/* ---------------- 滑鼠鍵盤注入（獨立程序，見 lib/input-worker.js） ---------------- */
let inputProc = null;

function startInputProcess() {
  inputProc = utilityProcess.fork(path.join(__dirname, 'lib', 'input-worker.js'), [], { serviceName: 'RD Host Input' });
  inputProc.on('exit', () => {
    inputProc = null;
    if (quitting) return;
    // 意外結束 → 重新啟動並重新接上畫面視窗
    setTimeout(() => {
      startInputProcess();
      connectInputPort();
    }, 1000);
  });
}

/** 建立「畫面視窗 ⇄ 注入程序」的直接通道，滑鼠鍵盤事件不經過主程序 */
function connectInputPort() {
  if (!inputProc || !win || win.isDestroyed()) return;
  const { port1, port2 } = new MessageChannelMain();
  inputProc.postMessage({ t: 'port' }, [port1]);
  win.webContents.postMessage('input-port', null, [port2]);
}

const input = {
  setRect: (r) => inputProc && inputProc.postMessage({ t: 'rect', ...r }),
  handle: (msg) => inputProc && inputProc.postMessage(msg),
  releaseAll: () => inputProc && inputProc.postMessage({ t: 'release-all' }),
};
const startHidden = process.argv.includes('--hidden');

const iconImage = () => nativeImage.createFromBuffer(circlePng(64, [59, 130, 246]));
const activeIconImage = () => nativeImage.createFromBuffer(circlePng(64, [239, 68, 68]));

function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: Math.min(760, screen.getPrimaryDisplay().workArea.height - 40), // 小螢幕時不要超出畫面
    minWidth: 380,
    minHeight: 560,
    title: 'RD Host',
    icon: iconImage(),
    show: !startHidden,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  // 每次載入（含重新整理）都給畫面視窗一條新的注入通道
  win.webContents.on('did-finish-load', connectInputPort);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    // 關閉視窗 → 縮到系統匣，繼續在背景等待連線
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  tray = new Tray(iconImage().resize({ width: 16, height: 16 }));
  tray.setToolTip('RD Host — 等待連線');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '顯示視窗', click: showWindow },
      { type: 'separator' },
      { label: '結束', click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', showWindow);
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

/* ---------------- 「遠端控制中」提示列 ---------------- */
function showBanner(from) {
  hideBanner();
  // 放在主螢幕右下角（工作列上方），避免蓋住視窗的標題列和縮小/關閉按鈕；可以拖曳移動
  const wa = screen.getPrimaryDisplay().workArea;
  const width = 360, height = 44;
  banner = new BrowserWindow({
    width, height,
    x: wa.x + wa.width - width - 12,
    y: wa.y + wa.height - height - 12,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  banner.setAlwaysOnTop(true, 'screen-saver');
  // 不讓提示列出現在傳出去的畫面裡（Windows 10 2004 以上支援）
  banner.setContentProtection(true);
  banner.loadFile(path.join(__dirname, 'renderer', 'banner.html'), { query: { from: from || '' } });
  banner.once('ready-to-show', () => banner && banner.showInactive());
  banner.on('closed', () => (banner = null));
  if (tray) {
    tray.setImage(activeIconImage().resize({ width: 16, height: 16 }));
    tray.setToolTip(`RD Host — 遠端控制中（${from || ''}）`);
  }
}

function hideBanner() {
  if (banner) banner.destroy();
  banner = null;
  if (tray) {
    tray.setImage(iconImage().resize({ width: 16, height: 16 }));
    tray.setToolTip('RD Host — 等待連線');
  }
}

/* ---------------- 控制其他電腦：遠端畫面視窗（直連模式） ---------------- */
const viewers = new Map(); // 對方名稱 -> BrowserWindow
const viewerCreds = new Map(); // webContents.id -> { name, wsUrl, password }（給視窗取一次就刪掉）
const viewerMeta = new Map(); // webContents.id -> { target, remember }

/** 對方的位址：Tailscale 清單裡有的用它的 IP，否則直接用使用者輸入的名稱或 IP */
async function resolveTarget(target) {
  const ts = await getTailscale({ maxAgeMs: 10000 });
  const all = [...ts.peers, ...(ts.self ? [ts.self] : [])];
  const hit = all.find((p) => p.name === target || p.ip === target);
  return hit ? hit.ip : target;
}
const wsUrlFor = (addr) => `ws://${addr.includes(':') ? `[${addr}]` : addr}:${SIGNAL_PORT}/ws`;

function openViewer({ name, wsUrl, password, remember }) {
  const existing = viewers.get(name);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  const v = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    title: `${name} — 遠端控制`,
    icon: iconImage(),
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'viewer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  v.removeMenu();
  const wcId = v.webContents.id;
  viewerCreds.set(wcId, { name, wsUrl, password: password || '' });
  viewerMeta.set(wcId, { target: name, remember: !!remember });
  viewers.set(name, v);
  // 控制端網頁內建在程式裡，不允許跳到其他網頁
  v.webContents.on('will-navigate', (e) => e.preventDefault());
  v.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  v.on('page-title-updated', (e) => e.preventDefault());
  v.on('closed', () => {
    viewers.delete(name);
    viewerCreds.delete(wcId);
    viewerMeta.delete(wcId);
  });
  v.loadFile(path.join(__dirname, 'viewer-web', 'index.html'));
}

/* ---------------- 記住的密碼（用 Windows DPAPI 加密保存） ---------------- */
function saved() {
  const list = config.get('saved');
  return Array.isArray(list) ? list : [];
}
function encryptPw(pw) {
  if (!pw || !safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(pw).toString('base64');
}
function decryptPw(b64) {
  if (!b64) return '';
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return '';
  }
}

/** 給介面用的電腦清單：Tailscale 裡的 Windows 電腦 + 手動加入的 */
async function listComputers() {
  const ts = await getTailscale({ maxAgeMs: 4000 });
  const savedList = saved();
  const selfName = ts.self ? ts.self.name : '';
  const items = ts.peers
    .filter((p) => p.os === 'windows' && p.name !== selfName)
    .map((p) => ({ name: p.name, ip: p.ip, online: p.online, inTailnet: true }));
  for (const s of savedList) {
    if (!items.some((i) => i.name === s.target || i.ip === s.target)) {
      items.push({ name: s.target, ip: '', online: null, inTailnet: false });
    }
  }
  for (const i of items) {
    i.hasPassword = savedList.some((s) => (s.target === i.name || (i.ip && s.target === i.ip)) && s.pw);
    i.saved = savedList.some((s) => s.target === i.name || (i.ip && s.target === i.ip));
  }
  return { tailscale: ts.state, self: ts.self, computers: items };
}

async function connectTo({ target, password, remember }) {
  target = String(target || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.\-:]{0,252}$/.test(target)) return { ok: false, reason: '請輸入對方的電腦名稱或 IP' };
  password = typeof password === 'string' ? password : '';
  const hit = saved().find((s) => s.target === target);
  if (!password && hit) password = decryptPw(hit.pw);
  const addr = await resolveTarget(target);
  // 密碼要等驗證成功（viewer-auth-ok）才保存，打錯的不會被記住
  openViewer({ name: target, wsUrl: wsUrlFor(addr), password, remember: !!remember });
  return { ok: true };
}

/** 遠端視窗驗證成功：勾了「記住密碼」就保存；已經記住過的也更新成這次成功的密碼 */
function rememberOnSuccess(meta, password) {
  if (!meta || !password) return;
  const list = saved().slice();
  const idx = list.findIndex((s) => s.target === meta.target);
  if (!meta.remember && idx < 0) return;
  const pw = encryptPw(password);
  if (!pw) return;
  const entry = { target: meta.target, pw };
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  config.set({ saved: list });
  if (win) win.webContents.send('computers-changed');
}

function forget(target) {
  config.set({ saved: saved().filter((s) => s.target !== String(target)) });
}

/** 提示列顯示控制者的電腦名稱（查不到就顯示 IP） */
async function nameForIp(ip) {
  try {
    const ts = await getTailscale({ maxAgeMs: 30000 });
    const hit = [...ts.peers, ...(ts.self ? [ts.self] : [])].find((p) => p.ip === ip);
    return hit ? `${hit.name}（${ip}）` : ip;
  } catch {
    return ip;
  }
}

/* ---------------- 螢幕清單 ---------------- */
async function getDisplays() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  return displays.map((d, i) => {
    const src = sources.find((s) => s.display_id === String(d.id)) || sources[i];
    const phys = screen.dipToScreenRect(null, d.bounds); // 實體像素（SendInput 用）
    return {
      id: String(d.id),
      name: `螢幕 ${i + 1}${d.id === primaryId ? '（主螢幕）' : ''}`,
      primary: d.id === primaryId,
      sourceId: src ? src.id : null,
      x: phys.x,
      y: phys.y,
      w: phys.width,
      h: phys.height,
    };
  });
}

/* ---------------- IPC ---------------- */
function state() {
  return {
    serverUrl: `ws://127.0.0.1:${SIGNAL_PORT}/ws`, // 本機內建的信令伺服器
    signalError,
    id: config.get('id'),
    otp: auth.otp,
    hasPermanent: !!config.get('permKey'),
    permRevealable: !!config.get('permPw'), // 有加密保存的明文，可以按眼睛顯示
    autoStart: !!config.get('autoStart'),
    version: app.getVersion(),
  };
}

function registerIpc() {
  ipcMain.handle('get-state', () => state());
  ipcMain.handle('save-identity', (_e, { id, secret }) => {
    const patch = { id: String(id) };
    if (secret) patch.secret = String(secret);
    config.set(patch);
  });
  ipcMain.handle('get-identity', () => ({ id: config.get('id'), secret: config.get('secret') }));
  ipcMain.handle('refresh-otp', () => auth.refreshOtp());
  ipcMain.handle('set-permanent-password', (_e, pw) => {
    if (pw != null && (typeof pw !== 'string' || pw.length < 8)) return { ok: false, reason: '密碼至少 8 個字元' };
    // permKey：驗證用的衍生金鑰；permPw：用 Windows DPAPI 加密的密碼，讓使用者可以按眼睛查看
    config.set({ permKey: auth.setPermanent(pw || null), permPw: pw ? encryptPw(pw) : null });
    return { ok: true, revealable: !!config.get('permPw') };
  });
  ipcMain.handle('get-permanent-password', () => decryptPw(config.get('permPw')));
  ipcMain.handle('set-auto-start', (_e, on) => {
    config.set({ autoStart: !!on });
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
    return !!on;
  });
  ipcMain.handle('new-challenge', (_e, sid) => auth.newChallenge(String(sid)));
  ipcMain.handle('verify', (_e, { sid, proof }) => auth.verify(String(sid), proof));
  ipcMain.handle('get-displays', () => getDisplays());
  ipcMain.handle('set-active-display', (_e, rect) => {
    input.setRect({ x: rect.x | 0, y: rect.y | 0, w: rect.w | 0, h: rect.h | 0 });
  });
  ipcMain.on('input', (_e, msg) => {
    if (msg && typeof msg === 'object') input.handle(msg);
  });
  ipcMain.handle('session-started', async (_e, info) => {
    // 被控制時把主視窗縮到系統匣：遠端看到的是乾淨的桌面，也不會誤觸設定。
    // 右下角的提示列仍可「中斷」，系統匣圖示可以把主視窗叫回來。
    if (win && win.isVisible()) win.hide();
    showBanner(await nameForIp(String((info && info.from) || '')));
  });
  ipcMain.handle('session-ended', () => {
    input.releaseAll();
    hideBanner();
  });
  ipcMain.handle('read-clipboard', () => clipboard.readText());
  ipcMain.handle('write-clipboard', (_e, text) => {
    if (typeof text === 'string' && text.length <= 1_000_000) clipboard.writeText(text);
  });
  ipcMain.handle('copy-text', (_e, text) => clipboard.writeText(String(text)));
  // 提示列上的「中斷」按鈕
  ipcMain.on('banner-disconnect', () => {
    if (win) win.webContents.send('force-disconnect');
  });

  // 控制其他電腦
  ipcMain.handle('list-computers', () => listComputers());
  ipcMain.handle('forget-computer', (_e, target) => {
    forget(target);
    return listComputers();
  });
  ipcMain.handle('connect-to', (_e, req) => connectTo(req || {}));
  // 以下兩個只給遠端畫面視窗使用
  ipcMain.handle('viewer-take', (e) => {
    const c = viewerCreds.get(e.sender.id);
    viewerCreds.delete(e.sender.id);
    return c || null;
  });
  ipcMain.on('viewer-auth-ok', (e, password) => {
    if (typeof password === 'string' && password.length <= 256) rememberOnSuccess(viewerMeta.get(e.sender.id), password);
  });
  // 控制端：遠端畫面出現後，把主視窗收到系統匣，只留下遠端視窗（系統匣圖示可以叫回來）
  ipcMain.on('viewer-connected', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || ![...viewers.values()].includes(w)) return;
    if (win && win.isVisible()) win.hide();
  });
  ipcMain.on('viewer-close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w && [...viewers.values()].includes(w)) w.close();
  });
}

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  config = new Config(app.getPath('userData'));
  auth = new Auth({ salt: config.get('salt'), permKey: config.get('permKey') });
  // 先啟動內建信令伺服器，畫面視窗才連得上
  try {
    await startSignaling({ port: SIGNAL_PORT, bind: process.env.RD_SIGNAL_BIND || undefined });
  } catch (e) {
    signalError = e.code === 'EADDRINUSE' ? `連接埠 ${SIGNAL_PORT} 已被其他程式使用` : e.message;
  }
  startInputProcess();
  registerIpc();
  createWindow();
  createTray();
});

app.on('before-quit', () => {
  quitting = true;
  input.releaseAll();
});
app.on('window-all-closed', () => {
  // 視窗關閉時留在系統匣
});
