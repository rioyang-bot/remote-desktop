'use strict';
/**
 * 瀏覽器 KeyboardEvent.code → Windows 掃描碼 (Set 1)
 *  s:  掃描碼
 *  e:  是否為延伸鍵 (E0 前綴)
 *  vk: 改用虛擬鍵碼送出（少數用掃描碼送會出問題的鍵）
 *
 * 使用掃描碼而非虛擬鍵碼，好處是與鍵盤配置無關、遊戲也能收到。
 */
const S = (s, e = false) => ({ s, e });
const V = (vk, e = false) => ({ vk, e });

const KEYMAP = {
  Escape: S(0x01),
  Digit1: S(0x02), Digit2: S(0x03), Digit3: S(0x04), Digit4: S(0x05), Digit5: S(0x06),
  Digit6: S(0x07), Digit7: S(0x08), Digit8: S(0x09), Digit9: S(0x0a), Digit0: S(0x0b),
  Minus: S(0x0c), Equal: S(0x0d), Backspace: S(0x0e), Tab: S(0x0f),
  KeyQ: S(0x10), KeyW: S(0x11), KeyE: S(0x12), KeyR: S(0x13), KeyT: S(0x14),
  KeyY: S(0x15), KeyU: S(0x16), KeyI: S(0x17), KeyO: S(0x18), KeyP: S(0x19),
  BracketLeft: S(0x1a), BracketRight: S(0x1b), Enter: S(0x1c), ControlLeft: S(0x1d),
  KeyA: S(0x1e), KeyS: S(0x1f), KeyD: S(0x20), KeyF: S(0x21), KeyG: S(0x22),
  KeyH: S(0x23), KeyJ: S(0x24), KeyK: S(0x25), KeyL: S(0x26),
  Semicolon: S(0x27), Quote: S(0x28), Backquote: S(0x29), ShiftLeft: S(0x2a), Backslash: S(0x2b),
  KeyZ: S(0x2c), KeyX: S(0x2d), KeyC: S(0x2e), KeyV: S(0x2f), KeyB: S(0x30),
  KeyN: S(0x31), KeyM: S(0x32), Comma: S(0x33), Period: S(0x34), Slash: S(0x35),
  ShiftRight: S(0x36), NumpadMultiply: S(0x37), AltLeft: S(0x38), Space: S(0x39), CapsLock: S(0x3a),
  F1: S(0x3b), F2: S(0x3c), F3: S(0x3d), F4: S(0x3e), F5: S(0x3f),
  F6: S(0x40), F7: S(0x41), F8: S(0x42), F9: S(0x43), F10: S(0x44),
  NumLock: V(0x90), ScrollLock: S(0x46),
  Numpad7: S(0x47), Numpad8: S(0x48), Numpad9: S(0x49), NumpadSubtract: S(0x4a),
  Numpad4: S(0x4b), Numpad5: S(0x4c), Numpad6: S(0x4d), NumpadAdd: S(0x4e),
  Numpad1: S(0x4f), Numpad2: S(0x50), Numpad3: S(0x51), Numpad0: S(0x52), NumpadDecimal: S(0x53),
  IntlBackslash: S(0x56), F11: S(0x57), F12: S(0x58),
  F13: S(0x64), F14: S(0x65), F15: S(0x66), F16: S(0x67), F17: S(0x68), F18: S(0x69),
  F19: S(0x6a), F20: S(0x6b), F21: S(0x6c), F22: S(0x6d), F23: S(0x6e), F24: S(0x76),
  KanaMode: S(0x70), IntlRo: S(0x73), Convert: S(0x79), NonConvert: S(0x7b), IntlYen: S(0x7d),
  NumpadComma: S(0x7e),
  Lang1: V(0x15), Lang2: V(0x19), // 韓文 Hangul / Hanja

  // 延伸鍵 (E0)
  NumpadEnter: S(0x1c, true), ControlRight: S(0x1d, true), NumpadDivide: S(0x35, true),
  PrintScreen: S(0x37, true), AltRight: S(0x38, true),
  Home: S(0x47, true), ArrowUp: S(0x48, true), PageUp: S(0x49, true),
  ArrowLeft: S(0x4b, true), ArrowRight: S(0x4d, true),
  End: S(0x4f, true), ArrowDown: S(0x50, true), PageDown: S(0x51, true),
  Insert: S(0x52, true), Delete: S(0x53, true),
  MetaLeft: S(0x5b, true), MetaRight: S(0x5c, true), ContextMenu: S(0x5d, true),
  OSLeft: S(0x5b, true), OSRight: S(0x5c, true),

  // Pause 的掃描碼是特殊序列，改用虛擬鍵
  Pause: V(0x13),

  // 多媒體鍵
  AudioVolumeMute: V(0xad, true), AudioVolumeDown: V(0xae, true), AudioVolumeUp: V(0xaf, true),
  MediaTrackNext: V(0xb0, true), MediaTrackPrevious: V(0xb1, true),
  MediaStop: V(0xb2, true), MediaPlayPause: V(0xb3, true),
  BrowserBack: V(0xa6, true), BrowserForward: V(0xa7, true), BrowserRefresh: V(0xa8, true),
  BrowserHome: V(0xac, true),
};

module.exports = { KEYMAP };
