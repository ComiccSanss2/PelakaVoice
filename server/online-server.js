// Starts the PelakaVoice server and exposes it worldwide through a Cloudflare quick tunnel
const path = require('path');
const { createSignalingServer } = require('./server');
const { ensureCloudflared, startTunnel, inviteCode } = require('./tunnel');

const PORT = parseInt(process.env.PORT, 10) || 3000;
let restarts = 0;

function banner(url) {
  const line = '='.repeat(58);
  console.log(`\n${line}\n  PELAKAVOICE ONLINE SERVER IS READY\n${line}\n`);
  console.log('  Invite code (send this to your friends):\n');
  console.log(`      ${inviteCode(url)}\n`);
  console.log(`  Full address: ${url}\n`);
  console.log('  Friends paste the invite code in PelakaVoice and press Join.');
  console.log('  Friends still on 1.0.0 must paste the full address; they will');
  console.log('  then be offered the update automatically.\n');
  console.log(`  Keep this window open. Press Ctrl+C to stop.\n${line}\n`);
}

function openTunnel(bin) {
  console.log('[..] Opening Cloudflare tunnel...');
  startTunnel(bin, PORT, {
    onUrl: (url) => { restarts = 0; banner(url); },
    onExit: (error) => {
      if (restarts++ >= 5) { console.error('[ERROR] Tunnel keeps failing. Check your internet connection.'); return; }
      console.log(`[..] Tunnel closed${error ? ' (' + error + ')' : ''}. Reconnecting — the invite code will change.`);
      setTimeout(() => openTunnel(bin), 2000 * restarts);
    }
  });
}

(async () => {
  try {
    await createSignalingServer(PORT).start();
    console.log(`[OK] Server listening on port ${PORT}`);
    const bin = await ensureCloudflared([__dirname, path.join(__dirname, 'bin')], (pct) => {
      process.stdout.write(`\r[..] Downloading tunnel component: ${pct}%   `);
    });
    openTunnel(bin);
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `[ERROR] Port ${PORT} is already in use.` : '[ERROR] ' + err.message);
    process.exit(1);
  }
})();
