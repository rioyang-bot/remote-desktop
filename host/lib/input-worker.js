'use strict';
/**
 * 滑鼠鍵盤注入的獨立程序（Electron utilityProcess）
 *
 * 為什麼不在主程序做：遠端按住「縮小 / 關閉」按鈕或拖曳標題列時，Windows 會讓那個視窗所屬的
 * 執行緒（RD Host 主程序）進入等待放開滑鼠的迴圈。如果注入也在主程序做，「放開滑鼠」就永遠送不出去，
 * 兩邊互相等待而卡死。放在獨立程序，並由畫面視窗透過 MessagePort 直接傳過來，就不受主程序影響。
 */
const { InputInjector } = require('./input');

const input = new InputInjector();

function handle(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'rect') {
    input.setRect({ x: msg.x | 0, y: msg.y | 0, width: Math.max(1, msg.w | 0), height: Math.max(1, msg.h | 0) });
    return;
  }
  try {
    input.handle(msg);
  } catch (e) {
    console.error('input error', e);
  }
}

process.parentPort.on('message', (e) => {
  // 主程序交給我們一個 MessagePort：之後畫面視窗的操作都直接從這裡進來
  for (const port of e.ports || []) {
    port.on('message', (ev) => handle(ev.data));
    port.on('close', () => input.releaseAll());
    port.start();
  }
  handle(e.data);
});
