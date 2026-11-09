// Cloudflare quick tunnel helper — shared by the desktop app and online-server.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

// Returns the path of cloudflared, downloading it once into the last directory of `dirs` if missing.
async function ensureCloudflared(dirs, onProgress) {
  for (const d of dirs) {
    const p = path.join(d, 'cloudflared.exe');
    try { if (fs.statSync(p).size > 10 * 1024 * 1024) return p; } catch (e) {}
  }
  if (process.platform !== 'win32') return 'cloudflared'; // expected on PATH

  const dir = dirs[dirs.length - 1];
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'cloudflared.exe');
  const tmp = dest + '.part';

  const res = await fetch(CLOUDFLARED_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Could not download the tunnel component (HTTP ${res.status})`);
  const total = parseInt(res.headers.get('content-length'), 10) || 0;
  let got = 0;
  let last = -1;
  const src = Readable.fromWeb(res.body);
  src.on('data', (chunk) => {
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (pct !== last) { last = pct; if (onProgress) onProgress(pct); }
  });
  await pipeline(src, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

// Starts a quick tunnel to 127.0.0.1:port. onUrl fires once the tunnel is actually reachable.
function startTunnel(bin, port, { onUrl, onExit } = {}) {
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let url = null;
  let registered = false;
  let announced = false;
  let exited = false;
  let timer = null;

  // The public hostname needs ~10-20 s to propagate. We deliberately do NOT probe it from this
  // machine: an early lookup gets a "not found" answer cached by the local DNS resolver.
  const announce = () => {
    if (announced || !url) return;
    announced = true;
    clearTimeout(timer);
    setTimeout(() => { if (!exited && onUrl) onUrl(url); }, 12000);
  };
  const feed = (data) => {
    const text = data.toString();
    if (!url) {
      const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m) { url = m[0]; timer = setTimeout(announce, 45000); }
    }
    if (/Registered tunnel connection/i.test(text)) registered = true;
    if (url && registered) announce();
  };
  const done = (error) => {
    if (exited) return;
    exited = true;
    clearTimeout(timer);
    if (onExit) onExit(error);
  };

  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('error', (err) => done(err.message));
  child.on('exit', (code) => done(code ? `Tunnel stopped (code ${code})` : null));

  return { stop: () => { exited = true; clearTimeout(timer); try { child.kill(); } catch (e) {} } };
}

// https://four-random-words.trycloudflare.com -> four-random-words
function inviteCode(url) {
  const m = /^https:\/\/([a-z0-9-]+)\.trycloudflare\.com/i.exec(url || '');
  return m ? m[1] : url;
}

module.exports = { ensureCloudflared, startTunnel, inviteCode };
