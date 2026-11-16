'use strict';
/**
 * 用 Win32 SendInput 注入滑鼠與鍵盤事件（透過 koffi 直接呼叫 user32.dll，不需要編譯器）
 *
 * 注意：
 *  - 一般權限執行時，無法控制「以系統管理員身分執行」的視窗（UIPI 限制）。
 *    需要的話請以系統管理員身分執行被控端。
 *  - Ctrl+Alt+Del、UAC 安全桌面無法用 SendInput 控制。
 */
const koffi = require('koffi');
const { KEYMAP } = require('./keymap');

const user32 = koffi.load('user32.dll');

const MOUSEINPUT = koffi.struct('RD_MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'int32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('RD_KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('RD_HARDWAREINPUT', {
  uMsg: 'uint32',
  wParamL: 'uint16',
  wParamH: 'uint16',
});
const INPUT_U = koffi.union('RD_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('RD_INPUT', { type: 'uint32', u: INPUT_U });

const SendInput = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int32']);
const GetSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int32', ['int32']);

const INPUT_SIZE = koffi.sizeof(INPUT);

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_XDOWN = 0x0080;
const MOUSEEVENTF_XUP = 0x0100;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;

const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const BUTTONS = {
  l: [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0],
  r: [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 0],
  m: [MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 0],
  x1: [MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 1],
  x2: [MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, 2],
};

function mouse(dx, dy, mouseData, dwFlags) {
  return SendInput(1, [{ type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData, dwFlags, time: 0, dwExtraInfo: 0 } } }], INPUT_SIZE);
}
function keyboard(wVk, wScan, dwFlags) {
  return SendInput(1, [{ type: INPUT_KEYBOARD, u: { ki: { wVk, wScan, dwFlags, time: 0, dwExtraInfo: 0 } } }], INPUT_SIZE);
}

class InputInjector {
  constructor() {
    /** 目前畫面所在螢幕的實體像素範圍 */
    this.rect = { x: 0, y: 0, width: 1920, height: 1080 };
    this.pressedKeys = new Set();
    this.pressedButtons = new Set();
  }

  setRect(rect) {
    this.rect = rect;
  }

  /** 把 0~1 座標換算成 SendInput 需要的虛擬桌面絕對座標 (0~65535) */
  moveTo(nx, ny) {
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    nx = Math.min(1, Math.max(0, nx));
    ny = Math.min(1, Math.max(0, ny));
    const { x, y, width, height } = this.rect;
    const px = x + Math.min(width - 1, Math.round(nx * width));
    const py = y + Math.min(height - 1, Math.round(ny * height));
    const vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
    const vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const vw = Math.max(2, GetSystemMetrics(SM_CXVIRTUALSCREEN));
    const vh = Math.max(2, GetSystemMetrics(SM_CYVIRTUALSCREEN));
    const ax = Math.round(((px - vx) * 65535) / (vw - 1));
    const ay = Math.round(((py - vy) * 65535) / (vh - 1));
    mouse(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK);
  }

  button(b, down) {
    const def = BUTTONS[b];
    if (!def) return;
    if (down) this.pressedButtons.add(b);
    else if (!this.pressedButtons.delete(b)) return;
    mouse(0, 0, def[2], down ? def[0] : def[1]);
  }

  wheel(dx, dy) {
    const clamp = (v) => Math.max(-12000, Math.min(12000, Math.trunc(v) || 0));
    dy = clamp(dy);
    dx = clamp(dx);
    if (dy) mouse(0, 0, dy, MOUSEEVENTF_WHEEL);
    if (dx) mouse(0, 0, dx, MOUSEEVENTF_HWHEEL);
  }

  key(code, down) {
    const k = KEYMAP[code];
    if (!k) return;
    if (down) this.pressedKeys.add(code);
    else if (!this.pressedKeys.delete(code)) return;
    let flags = down ? 0 : KEYEVENTF_KEYUP;
    if (k.e) flags |= KEYEVENTF_EXTENDEDKEY;
    if (k.vk) keyboard(k.vk, 0, flags);
    else keyboard(0, k.s, flags | KEYEVENTF_SCANCODE);
  }

  releaseAll() {
    for (const code of [...this.pressedKeys]) this.key(code, false);
    for (const b of [...this.pressedButtons]) this.button(b, false);
  }

  /** 處理控制端送來的訊息 */
  handle(msg) {
    switch (msg.t) {
      case 'mm':
        return this.moveTo(msg.x, msg.y);
      case 'md':
        this.moveTo(msg.x, msg.y);
        return this.button(msg.b, true);
      case 'mu':
        this.moveTo(msg.x, msg.y);
        return this.button(msg.b, false);
      case 'wh':
        return this.wheel(msg.dx, msg.dy);
      case 'kd':
        return typeof msg.code === 'string' && this.key(msg.code, true);
      case 'ku':
        return typeof msg.code === 'string' && this.key(msg.code, false);
      case 'release-all':
        return this.releaseAll();
    }
  }
}

module.exports = { InputInjector, INPUT_SIZE, _test: { mouse, GetSystemMetrics } };
