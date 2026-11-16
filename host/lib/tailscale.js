'use strict';
/**
 * 讀取 Tailscale 狀態：本機名稱、IP，以及同一個 Tailscale 網路裡的其他電腦。
 * 透過 tailscale.exe status --json，不需要任何權限。
 */
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { isTailscale } = require('./signaling');

const TS_EXE = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');

const shortName = (dns) => String(dns || '').replace(/\.$/, '').split('.')[0].toLowerCase();
const ipv4 = (ips) => (ips || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || (ips || [])[0] || '';

/** 從網路介面找本機的 Tailscale IPv4（tailscale.exe 讀不到時的備案） */
function localTailscaleIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && isTailscale(a.address)) return a.address;
  }
  return '';
}

function run() {
  return new Promise((resolve) => {
    execFile(TS_EXE, ['status', '--json'], { timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err && !stdout ? { err } : { stdout }));
  });
}

let cache = null;
let cacheAt = 0;

/**
 * @returns {Promise<{ state: 'running'|'stopped'|'not-installed',
 *   self: { name: string, ip: string } | null,
 *   peers: { name: string, ip: string, online: boolean, os: string }[] }>}
 */
async function getStatus({ maxAgeMs = 5000 } = {}) {
  if (cache && Date.now() - cacheAt < maxAgeMs) return cache;
  const r = await run();
  let result;
  if (r.err) {
    const ip = localTailscaleIp();
    result = r.err.code === 'ENOENT'
      ? { state: 'not-installed', self: ip ? { name: os.hostname().toLowerCase(), ip } : null, peers: [] }
      : { state: ip ? 'running' : 'stopped', self: ip ? { name: os.hostname().toLowerCase(), ip } : null, peers: [] };
  } else {
    let j = {};
    try {
      j = JSON.parse(r.stdout);
    } catch {}
    const running = j.BackendState === 'Running';
    const self = j.Self && running
      ? { name: shortName(j.Self.DNSName) || String(j.Self.HostName || '').toLowerCase(), ip: ipv4(j.Self.TailscaleIPs) }
      : null;
    const peers = Object.values(j.Peer || {})
      .map((p) => ({
        name: shortName(p.DNSName) || String(p.HostName || '').toLowerCase(),
        ip: ipv4(p.TailscaleIPs),
        online: !!p.Online,
        os: String(p.OS || ''),
      }))
      .filter((p) => p.name && p.ip)
      .sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
    result = { state: running ? 'running' : 'stopped', self, peers: running ? peers : [] };
  }
  cache = result;
  cacheAt = Date.now();
  return result;
}

module.exports = { getStatus };
