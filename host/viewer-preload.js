'use strict';
/**
 * 遠端畫面視窗的 preload：
 * 視窗載入伺服器上的控制端網頁，這裡只提供「取得這次要連線的 ID / 密碼」和「關閉視窗」兩個功能。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rdViewer', {
  /** 取得連線資訊（只能取一次，之後回傳 null） */
  take: () => ipcRenderer.invoke('viewer-take'),
  close: () => ipcRenderer.send('viewer-close'),
  /** 密碼驗證成功：程式依使用者的選擇記住這組密碼 */
  authOk: (password) => ipcRenderer.send('viewer-auth-ok', String(password || '')),
  /** 遠端畫面已經出現：程式把主視窗收到系統匣 */
  connected: () => ipcRenderer.send('viewer-connected'),
});
