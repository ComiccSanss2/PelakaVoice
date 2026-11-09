// PelakaVoice JukeBox — a shared YouTube audio queue per lobby.
// The host server fetches the audio track with yt-dlp (downloaded once, kept up to date),
// serves it over HTTP and keeps everyone's playback in sync. Pause / skip / volume need a
// majority of the people currently in the voice lobby.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const LIMITS = {
  queue: 25,            // tracks waiting per lobby
  perUser: 5,           // tracks one person can have waiting
  maxDuration: 20 * 60, // seconds
  maxFile: '60M',
  downloads: 2,         // concurrent yt-dlp processes on this server
  voteMs: 30000,        // a vote expires after 30 s
  startLead: 1200,      // ms given to clients to buffer before a track starts
  volStep: 0.1
};

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
function binaryName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

// Accepts youtube.com/watch?v=, youtu.be/, /shorts/, /live/, /embed/, music.youtube.com, m.youtube.com
function parseYouTube(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = /^\/(shorts|live|embed|v)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[2];
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

function friendlyError(text) {
  const t = String(text || '');
  if (/not a bot|sign in to confirm you/i.test(t)) return 'YouTube refused this server (bot check). Hosting from a home PC usually works.';
  if (/confirm your age|age-restricted|inappropriate for some users/i.test(t)) return 'This video is age-restricted.';
  if (/private video/i.test(t)) return 'This video is private.';
  if (/members-only|join this channel/i.test(t)) return 'This video is members-only.';
  if (/not available in your country|blocked it in your country/i.test(t)) return 'This video is not available in the host\'s country.';
  if (/does not pass filter|too long/i.test(t)) return `Videos longer than ${LIMITS.maxDuration / 60} minutes or live streams can't be added.`;
  if (/larger than max-filesize|File is larger/i.test(t)) return 'This track is too large.';
  if (/video unavailable|has been removed|does not exist/i.test(t)) return 'This video is unavailable.';
  return 'Could not load this video.';
}

function createJukebox({ io, binDir, cacheDir, systemMessage }) {
  binDir = binDir || path.join(__dirname, 'bin');
  cacheDir = cacheDir || path.join(require('os').tmpdir(), 'pelakavoice-jukebox');
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(cacheDir, { recursive: true });

  const tracks = new Map(); // trackId -> track (for HTTP lookups)
  let binReady = null;
  let running = 0;
  const waiting = [];

  // ---------- yt-dlp binary ----------
  async function downloadBinary(dest) {
    const res = await fetch(RELEASE + binaryName(), { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Could not download the JukeBox component (HTTP ${res.status})`);
    const tmp = dest + '.part';
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  }

  function ensureBinary() {
    if (binReady) return binReady;
    binReady = (async () => {
      fs.mkdirSync(binDir, { recursive: true });
      const dest = path.join(binDir, binaryName());
      let st = null;
      try { st = fs.statSync(dest); } catch (e) {}
      if (!st || st.size < 1024 * 1024) {
        await downloadBinary(dest);
      } else if (Date.now() - st.mtimeMs > 4 * 24 * 3600 * 1000) {
        // YouTube changes often: refresh a binary older than 4 days (keep the old one if that fails)
        await new Promise((resolve) => {
          const p = spawn(dest, ['-U'], { windowsHide: true, stdio: 'ignore' });
          const t = setTimeout(() => { try { p.kill(); } catch (e) {} resolve(); }, 60000);
          p.on('exit', () => { clearTimeout(t); try { const now = new Date(); fs.utimesSync(dest, now, now); } catch (e) {} resolve(); });
          p.on('error', () => { clearTimeout(t); resolve(); });
        });
      }
      return dest;
    })();
    binReady.catch(() => { binReady = null; });
    return binReady;
  }

  // ---------- fetching a track ----------
  function slot(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        running++;
        fn().then(resolve, reject).finally(() => { running--; const next = waiting.shift(); if (next) next(); });
      };
      if (running < LIMITS.downloads) run(); else waiting.push(run);
    });
  }

  function fetchAudio(track, onMeta) {
    return slot(async () => {
      if (track.cancelled) throw new Error('cancelled');
      const bin = await ensureBinary();
      return new Promise((resolve, reject) => {
        const args = [
          // YouTube needs a JavaScript runtime: reuse the Node.js (or Electron-as-Node) running this server
          '--js-runtimes', 'node:' + process.execPath,
          '--no-playlist', '--no-warnings', '--no-progress', '--no-simulate', '--no-mtime', '--no-cache-dir',
          '-f', 'bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio',
          '--match-filter', `!is_live & duration <= ${LIMITS.maxDuration}`,
          '--max-filesize', LIMITS.maxFile,
          '-o', path.join(cacheDir, `${track.id}.%(ext)s`),
          '--print', 'before_dl:PVMETA %(.{title,duration,uploader})j',
          '--print', 'after_move:PVFILE %(filepath)s',
          'https://www.youtube.com/watch?v=' + track.videoId
        ];
        const child = spawn(bin, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' }
        });
        track.proc = child;
        let out = '', err = '', file = null;
        const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, 180000);
        child.stdout.on('data', (d) => {
          out += d.toString('utf8');
          let i;
          while ((i = out.indexOf('\n')) >= 0) {
            const line = out.slice(0, i).trim();
            out = out.slice(i + 1);
            if (line.startsWith('PVMETA ')) { try { onMeta(JSON.parse(line.slice(7))); } catch (e) {} }
            else if (line.startsWith('PVFILE ')) file = line.slice(7).trim();
          }
        });
        child.stderr.on('data', (d) => { if (err.length < 8000) err += d.toString('utf8'); });
        child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.message)); });
        child.on('exit', () => {
          clearTimeout(timer);
          track.proc = null;
          if (out.trim().startsWith('PVFILE ')) file = out.trim().slice(7).trim();
          if (track.cancelled) return reject(new Error('cancelled'));
          if (file && fs.existsSync(file)) return resolve(file);
          if (!err.trim()) err = 'does not pass filter'; // yt-dlp skips filtered videos silently (live / too long)
          reject(new Error(friendlyError(err)));
        });
      });
    });
  }

  function dropFile(track) {
    tracks.delete(track.id);
    if (track.proc) { track.cancelled = true; try { track.proc.kill(); } catch (e) {} }
    track.cancelled = true;
    if (track.file) fs.unlink(track.file, () => {});
  }

  // ---------- lobby state ----------
  function jb(lobby) {
    if (!lobby.jb) {
      lobby.jb = { queue: [], current: null, paused: false, startedAt: 0, pausePos: 0, volume: 0.6, votes: {}, timer: null };
    }
    return lobby.jb;
  }

  const pubTrack = (t) => t && ({
    id: t.id, videoId: t.videoId, title: t.title, duration: t.duration, uploader: t.uploader,
    byName: t.byName, byTag: t.byTag, status: t.status, error: t.error || undefined
  });

  const need = (lobby) => Math.floor(lobby.users.size / 2) + 1;

  function liveVoters(lobby, vote) {
    const present = new Set(Array.from(lobby.users.values(), u => u.tag));
    for (const t of Array.from(vote.voters)) if (!present.has(t)) vote.voters.delete(t);
    return vote.voters.size;
  }

  function position(j, now = Date.now()) {
    if (!j.current) return 0;
    return j.paused ? j.pausePos : Math.max(0, (now - j.startedAt) / 1000);
  }

  function snapshot(lobby) {
    const j = jb(lobby);
    const now = Date.now();
    const votes = {};
    for (const [kind, v] of Object.entries(j.votes)) {
      if (now > v.expires) { delete j.votes[kind]; continue; }
      liveVoters(lobby, v);
      votes[kind] = { action: v.action, value: v.value, voters: Array.from(v.voters), byName: v.byName, expires: v.expires };
    }
    return {
      lobbyId: lobby.id,
      current: pubTrack(j.current),
      queue: j.queue.map(pubTrack),
      paused: j.paused,
      startedAt: j.startedAt,
      pausePos: j.pausePos,
      volume: j.volume,
      votes,
      need: need(lobby),
      members: lobby.users.size,
      serverNow: now
    };
  }

  function broadcast(lobby) {
    io.to(lobby.id).emit('jb_state', snapshot(lobby));
  }

  function schedule(lobby) {
    const j = jb(lobby);
    clearTimeout(j.timer);
    j.timer = null;
    if (!j.current || j.paused) return;
    const left = (j.current.duration || 0) - position(j);
    j.timer = setTimeout(() => advance(lobby), Math.max(0, left * 1000) + 800);
  }

  // Starts the next ready track (if nothing is playing)
  function advance(lobby, reason) {
    const j = jb(lobby);
    if (j.current) { dropFile(j.current); j.current = null; }
    delete j.votes.skip;
    delete j.votes.pause;
    const idx = j.queue.findIndex(t => t.status === 'ready');
    if (idx >= 0 && j.queue.slice(0, idx).every(t => t.status !== 'loading')) {
      j.current = j.queue.splice(idx, 1)[0];
      j.paused = false;
      j.pausePos = 0;
      j.startedAt = Date.now() + LIMITS.startLead;
      if (reason !== 'quiet') systemMessage(lobby, `🎵 Now playing: ${j.current.title}`);
    }
    schedule(lobby);
    broadcast(lobby);
  }

  function maybeStart(lobby) {
    const j = jb(lobby);
    if (!j.current) advance(lobby);
    else broadcast(lobby);
  }

  // ---------- votes ----------
  function apply(lobby, vote) {
    const j = jb(lobby);
    if (vote.action === 'skip') {
      const title = j.current ? j.current.title : '';
      systemMessage(lobby, `⏭️ Skipped by vote: ${title}`);
      advance(lobby);
      return;
    }
    if (vote.action === 'pause' && j.current && !j.paused) {
      j.pausePos = position(j);
      j.paused = true;
      systemMessage(lobby, '⏸️ JukeBox paused by vote');
    } else if (vote.action === 'resume' && j.current && j.paused) {
      j.startedAt = Date.now() + 300 - j.pausePos * 1000;
      j.paused = false;
      systemMessage(lobby, '▶️ JukeBox resumed by vote');
    } else if (vote.action === 'volume') {
      j.volume = vote.value;
      systemMessage(lobby, `🔊 JukeBox volume set to ${Math.round(vote.value * 100)}% by vote`);
    }
    schedule(lobby);
    broadcast(lobby);
  }

  function checkVotes(lobby) {
    const j = jb(lobby);
    for (const [kind, v] of Object.entries(j.votes)) {
      if (Date.now() > v.expires) { delete j.votes[kind]; continue; }
      if (liveVoters(lobby, v) >= need(lobby)) {
        delete j.votes[kind];
        apply(lobby, v);
      }
    }
  }

  // ---------- public API used by server.js ----------
  function attach(socket, ctx) {
    const { me, myLobby, allow, ack } = ctx;

    socket.on('jb_get', (cb) => {
      const lobby = myLobby();
      ack(cb, lobby ? { success: true, state: snapshot(lobby) } : { success: false });
    });

    socket.on('jb_add', (data, cb) => {
      const user = me();
      const lobby = myLobby();
      if (!lobby) return ack(cb, { success: false, error: 'Join a lobby first.' });
      const videoId = parseYouTube(data && data.url);
      if (!videoId) return ack(cb, { success: false, error: 'Paste a YouTube video link (youtube.com/watch?v=… or youtu.be/…).' });
      if (!allow('jb_add', 1500)) return ack(cb, { success: false, error: 'Wait a moment before adding another track.' });
      const j = jb(lobby);
      if (j.queue.length >= LIMITS.queue) return ack(cb, { success: false, error: `The queue is full (${LIMITS.queue} tracks).` });
      if (j.queue.filter(t => t.byTag === user.tag).length >= LIMITS.perUser) {
        return ack(cb, { success: false, error: `You already have ${LIMITS.perUser} tracks waiting in the queue.` });
      }
      const track = {
        id: crypto.randomBytes(9).toString('base64url'), videoId, title: 'Loading…', duration: 0, uploader: '',
        byName: user.username, byTag: user.tag, status: 'loading', file: null, lobbyId: lobby.id
      };
      j.queue.push(track);
      tracks.set(track.id, track);
      broadcast(lobby);
      ack(cb, { success: true, id: track.id });

      fetchAudio(track, (meta) => {
        track.title = String(meta.title || 'Untitled').slice(0, 140);
        track.duration = Math.max(1, Math.round(Number(meta.duration) || 0));
        track.uploader = String(meta.uploader || '').slice(0, 60);
        if (!track.cancelled) broadcast(lobby);
      }).then((file) => {
        if (track.cancelled) { fs.unlink(file, () => {}); return; }
        track.file = file;
        track.status = 'ready';
        track.mime = /\.webm$/i.test(file) ? 'audio/webm' : /\.(m4a|mp4)$/i.test(file) ? 'audio/mp4' : 'application/octet-stream';
        if (track.title === 'Loading…') track.title = 'Untitled';
        systemMessage(lobby, `🎶 ${track.byName} added to the JukeBox: ${track.title}`);
        maybeStart(lobby);
      }).catch((e) => {
        if (track.cancelled) return;
        const i = j.queue.indexOf(track);
        if (i >= 0) j.queue.splice(i, 1);
        dropFile(track);
        const s = io.sockets.sockets.get(socket.id);
        if (s) s.emit('jb_error', { error: e.message });
        maybeStart(lobby); // a failed track may have been blocking the next one
      });
    });

    socket.on('jb_remove', (data, cb) => {
      const user = me();
      const lobby = myLobby();
      if (!lobby) return ack(cb, { success: false, error: 'Join a lobby first.' });
      const j = jb(lobby);
      const i = j.queue.findIndex(t => t.id === (data && data.id));
      if (i < 0) return ack(cb, { success: false, error: 'Track not found.' });
      const t = j.queue[i];
      if (t.byTag !== user.tag && lobby.creatorTag !== user.tag) {
        return ack(cb, { success: false, error: 'Only who added it (or the lobby creator) can remove a queued track.' });
      }
      j.queue.splice(i, 1);
      dropFile(t);
      ack(cb, { success: true });
      maybeStart(lobby);
    });

    // action: 'pause' | 'resume' | 'skip' | 'volume' (value 0..1)
    socket.on('jb_vote', (data, cb) => {
      const user = me();
      const lobby = myLobby();
      if (!lobby) return ack(cb, { success: false, error: 'Join a lobby first.' });
      if (!allow('jb_vote', 250)) return ack(cb, { success: false, rate: true });
      const j = jb(lobby);
      const action = data && data.action;
      let kind, value;
      if (action === 'skip') {
        if (!j.current) return ack(cb, { success: false, error: 'Nothing is playing.' });
        kind = 'skip';
      } else if (action === 'pause' || action === 'resume') {
        if (!j.current) return ack(cb, { success: false, error: 'Nothing is playing.' });
        if ((action === 'pause') === j.paused) return ack(cb, { success: false, error: j.paused ? 'Already paused.' : 'Already playing.' });
        kind = 'pause';
      } else if (action === 'volume') {
        value = Math.round(Math.min(1, Math.max(0, Number(data.value))) * 100) / 100;
        if (!Number.isFinite(value)) return ack(cb, { success: false, error: 'Invalid volume.' });
        if (Math.abs(value - j.volume) < 0.005) return ack(cb, { success: false, error: 'The volume is already there.' });
        kind = 'volume';
      } else {
        return ack(cb, { success: false, error: 'Unknown action.' });
      }

      let v = j.votes[kind];
      const same = v && Date.now() <= v.expires && v.action === action && (kind !== 'volume' || v.value === value);
      if (!same) {
        v = j.votes[kind] = { action, value, voters: new Set(), byName: user.username, expires: Date.now() + LIMITS.voteMs };
      }
      if (same && v.voters.has(user.tag) && data.toggle) v.voters.delete(user.tag); // click again to withdraw
      else v.voters.add(user.tag);
      ack(cb, { success: true });
      if (v.voters.size >= need(lobby)) {
        delete j.votes[kind];
        apply(lobby, v);
      } else {
        broadcast(lobby);
        setTimeout(() => { if (j.votes[kind] === v) { delete j.votes[kind]; broadcast(lobby); } }, LIMITS.voteMs + 50);
      }
    });
  }

  // Called by server.js when the lobby membership changes
  function onMembersChanged(lobby) {
    if (!lobby.jb) return;
    if (lobby.users.size === 0) return resetLobby(lobby);
    checkVotes(lobby);
    broadcast(lobby);
  }

  function resetLobby(lobby) {
    const j = lobby.jb;
    if (!j) return;
    clearTimeout(j.timer);
    if (j.current) dropFile(j.current);
    j.queue.forEach(dropFile);
    lobby.jb = null;
  }

  // ---------- HTTP: GET /jukebox/<trackId> (range requests, so clients can seek) ----------
  function serve(req, res, id, cors) {
    const t = tracks.get(id);
    if (!t || t.status !== 'ready' || !t.file) {
      res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    fs.stat(t.file, (err, st) => {
      if (err) { res.writeHead(404, cors); return res.end(); }
      const headers = { ...cors, 'Content-Type': t.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' };
      const head = req.method === 'HEAD';
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && (m[1] || m[2])) {
        const start = m[1] ? parseInt(m[1], 10) : Math.max(0, st.size - parseInt(m[2], 10));
        const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) {
          res.writeHead(416, { ...cors, 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        if (head) return res.end();
        return fs.createReadStream(t.file, { start, end }).on('error', () => res.destroy()).pipe(res);
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (head) return res.end();
      fs.createReadStream(t.file).on('error', () => res.destroy()).pipe(res);
    });
  }

  function stop(lobbies) {
    for (const l of lobbies.values()) resetLobby(l);
    try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (e) {}
  }

  return { attach, onMembersChanged, resetLobby, snapshot: (l) => snapshot(l), serve, stop, ensureBinary };
}

module.exports = { createJukebox, parseYouTube, LIMITS };
