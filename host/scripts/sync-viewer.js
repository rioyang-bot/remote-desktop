'use strict';
// 把控制端網頁（server/public）複製進程式，遠端畫面視窗直接載入本機檔案。
// npm start 和 npm run dist 之前會自動執行。
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'server', 'public');
const dst = path.join(__dirname, '..', 'viewer-web');
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of ['index.html', 'viewer.css', 'viewer.js', 'sha256.js']) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
console.log('viewer-web 已更新');
