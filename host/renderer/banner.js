'use strict';
const from = new URLSearchParams(location.search).get('from');
const start = Date.now();
const text = document.getElementById('text');
function tick() {
  const s = Math.floor((Date.now() - start) / 1000);
  const t = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  text.textContent = `遠端控制中${from ? '（' + from + '）' : ''}  ${t}`;
}
tick();
setInterval(tick, 1000);
document.getElementById('stop').addEventListener('click', () => window.rd.bannerDisconnect());
