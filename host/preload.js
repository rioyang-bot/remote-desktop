'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** 主程序給的「畫面視窗 ⇄ 滑鼠鍵盤注入程序」直接通道 */
let inputPort = null;
ipcRenderer.on('input-port', (e) => {
  if (inputPort) inputPort.close();
  inputPort = e.ports[0] || null;
});

contextBridge.exposeInMainWorld('rd', {
  getState: () => ipcRenderer.invoke('get-state'),
  getIdentity: () => ipcRenderer.invoke('get-identity'),
  saveIdentity: (id, secret) => ipcRenderer.invoke('save-identity', { id, secret }),
  refreshOtp: () => ipcRenderer.invoke('refresh-otp'),
  setPermanentPassword: (pw) => ipcRenderer.invoke('set-permanent-password', pw),
  getPermanentPassword: () => ipcRenderer.invoke('get-permanent-password'),
  setAutoStart: (on) => ipcRenderer.invoke('set-auto-start', on),
  newChallenge: (sid) => ipcRenderer.invoke('new-challenge', sid),
  verify: (sid, proof) => ipcRenderer.invoke('verify', { sid, proof }),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  setActiveDisplay: (d) => {
    if (inputPort) inputPort.postMessage({ t: 'rect', x: d.x, y: d.y, w: d.w, h: d.h });
    return ipcRenderer.invoke('set-active-display', d);
  },
  // 滑鼠鍵盤事件直接送到注入程序，不經過主程序（主程序可能卡在 Windows 的視窗拖曳/按鈕迴圈裡）
  input: (msg) => {
    if (inputPort) inputPort.postMessage(msg);
    else ipcRenderer.send('input', msg);
  },
  sessionStarted: (info) => ipcRenderer.invoke('session-started', info),
  sessionEnded: () => ipcRenderer.invoke('session-ended'),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  onForceDisconnect: (fn) => ipcRenderer.on('force-disconnect', () => fn()),
  bannerDisconnect: () => ipcRenderer.send('banner-disconnect'),
  listComputers: () => ipcRenderer.invoke('list-computers'),
  forgetComputer: (target) => ipcRenderer.invoke('forget-computer', target),
  connectTo: (req) => ipcRenderer.invoke('connect-to', req),
  onComputersChanged: (fn) => ipcRenderer.on('computers-changed', () => fn()),
});
