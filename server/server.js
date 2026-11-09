// PelakaVoice signaling server — plain http + socket.io (no express)
// User-created lobbies with chat + shared soundboard, friends presence, DMs, update feed
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { createJukebox } = require('./jukebox');

const SERVER_VERSION = '2.4.0';
const REACTIONS = ['😂', '🔥', '👏', '❤️', '😮', '🎉', '💀', '👀', '😭', '🤯'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' };
const LIMITS = {
  maxLobbies: 100,
  lobbiesPerUser: 5,
  abandonMs: 30 * 60 * 1000, // empty lobby whose creator is offline is removed after 30 min
  chatHistory: 100,
  chatLen: 500,
  soundsPerLobby: 30,
  soundsPerUser: 8,
  soundBytes: 200 * 1024
};

function compareVersions(v1, v2) {
  const a = String(v1 || '0').split('.').map(n => parseInt(n, 10) || 0);
  const b = String(v2 || '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
  }
  return 0;
}

function createSignalingServer(port = 3000, opts = {}) {
  const updatesDir = opts.updatesDir || path.join(__dirname, 'updates');
  const users = new Map();   // socketId -> user
  const lobbies = new Map(); // lobbyId -> lobby (created by users only)
  const calls = new Map();   // callId -> { id, callerId, receiverId, status }
  let seq = 0;

  // Optional TURN relay (for friends behind strict NAT): set TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL
  const iceServers = [];
  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map(s => s.trim()),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }

  // ---------- HTTP ----------
  function json(res, code, body) {
    res.writeHead(code, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function readVersionInfo() {
    try { return JSON.parse(fs.readFileSync(path.join(updatesDir, 'version.json'), 'utf8')); } catch (e) { return null; }
  }

  // Static update files with single-range support (resume + differential downloads)
  function serveUpdateFile(req, res, name) {
    let file;
    try { file = path.join(updatesDir, path.basename(decodeURIComponent(name))); } catch (e) { return json(res, 400, { error: 'Bad request' }); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return json(res, 404, { error: 'Not found' });
      const meta = /\.(yml|json)$/i.test(file);
      const headers = {
        ...CORS,
        'Content-Type': meta ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': meta ? 'no-store' : 'public, max-age=600'
      };
      const head = req.method === 'HEAD';
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && (m[1] || m[2])) {
        const start = m[1] ? parseInt(m[1], 10) : Math.max(0, st.size - parseInt(m[2], 10));
        const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
        if (start > end || start >= st.size) {
          res.writeHead(416, { ...CORS, 'Content-Range': `bytes */${st.size}` });
          return res.end();
        }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
        if (head) return res.end();
        return fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
      }
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (head) return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch (e) { return json(res, 400, { error: 'Bad request' }); }
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });

    if (u.pathname === '/' || u.pathname === '/status') {
      return json(res, 200, {
        status: 'online', name: 'PelakaVoice', version: SERVER_VERSION,
        activeUsers: users.size, activeLobbies: lobbies.size, uptime: Math.round(process.uptime())
      });
    }

    // Legacy endpoint: this is what PelakaVoice 1.0.x clients call right after login
    if (u.pathname === '/api/check-update') {
      const clientVersion = u.searchParams.get('version') || '1.0.0';
      const info = readVersionInfo();
      if (!info || !info.version) return json(res, 200, { hasUpdate: false });
      return json(res, 200, {
        hasUpdate: compareVersions(info.version, clientVersion) > 0,
        currentVersion: clientVersion,
        latestVersion: info.version,
        releaseNotes: info.releaseNotes || 'New features and improvements.',
        downloadUrl: `/updates/${encodeURIComponent(info.fileName || 'PelakaVoice-latest.exe')}`
      });
    }

    if (u.pathname.startsWith('/updates/')) return serveUpdateFile(req, res, u.pathname.slice(9));
    if (u.pathname.startsWith('/jukebox/')) return jukebox.serve(req, res, u.pathname.slice(9), CORS);
    json(res, 404, { error: 'Not found' });
  });

  // ---------- SOCKET.IO ----------
  const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    serveClient: false,
    perMessageDeflate: false,
    pingInterval: 20000,
    pingTimeout: 25000,
    maxHttpBufferSize: LIMITS.soundBytes + 64 * 1024
  });
  const jukebox = createJukebox({ io, binDir: opts.binDir, cacheDir: opts.cacheDir, systemMessage: (l, t) => systemMessage(l, t) });

  const pub = (u) => ({
    id: u.id, username: u.username, tag: u.tag, avatarColor: u.avatarColor, status: u.status,
    isMuted: u.isMuted, isDeafened: u.isDeafened, isSpeaking: u.isSpeaking, isStreaming: !!u.isStreaming
  });
  const ack = (cb, value) => { if (typeof cb === 'function') cb(value); };
  const socketOf = (id) => io.sockets.sockets.get(id);
  const lobbyInfo = (l) => ({
    id: l.id, name: l.name, isPrivate: l.isPrivate, maxUsers: l.maxUsers, creator: l.creator, creatorTag: l.creatorTag
  });
  const soundList = (l) => Array.from(l.sounds.values(), s => ({
    id: s.id, name: s.name, duration: s.duration, uploaderName: s.uploaderName, uploaderTag: s.uploaderTag
  }));

  function getLobbiesList() {
    const list = [];
    for (const l of lobbies.values()) {
      list.push({ ...lobbyInfo(l), userCount: l.users.size, users: Array.from(l.users.values(), pub) });
    }
    return list;
  }

  // Coalesce bursts of lobby changes into one broadcast
  let lobbiesTimer = null;
  function broadcastLobbies() {
    if (lobbiesTimer) return;
    lobbiesTimer = setTimeout(() => { lobbiesTimer = null; io.emit('lobbies_updated', getLobbiesList()); }, 40);
  }

  function findUser(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    let byName = null;
    for (const u of users.values()) {
      if (u.tag.toLowerCase() === q) return u;
      if (!byName && u.username.toLowerCase() === q) byName = u;
    }
    return byName;
  }

  function tagOnline(tag) {
    for (const u of users.values()) if (u.tag === tag) return true;
    return false;
  }

  function notifyFriends(user, statusOverride) {
    if (!user || user.friends.size === 0) return;
    const friend = { ...pub(user), status: statusOverride || user.status };
    if (statusOverride === 'offline') friend.id = null;
    for (const other of users.values()) {
      if (other.id !== user.id && user.friends.has(other.tag)) io.to(other.id).emit('friend_updated', { friend });
    }
  }

  function pushMessage(lobby, msg) {
    lobby.messages.push(msg);
    while (lobby.messages.length > LIMITS.chatHistory) {
      const old = lobby.messages.shift();
      if (old.kind === 'poll') lobby.polls.delete(old.pollId);
    }
    io.to(lobby.id).emit('lobby_chat', msg);
  }

  function systemMessage(lobby, text) {
    pushMessage(lobby, { kind: 'system', id: ++seq, senderName: '', senderTag: '', text, ts: Date.now() });
  }

  function leaveLobby(user) {
    const id = user && user.currentLobbyId;
    if (!id) return;
    user.currentLobbyId = null;
    user.isSpeaking = false;
    user.isStreaming = false;
    if (user.status === 'in_lobby') user.status = 'online';
    const s = socketOf(user.id);
    if (s) s.leave(id);
    const lobby = lobbies.get(id);
    if (!lobby) return;
    lobby.users.delete(user.id);
    if (lobby.users.size === 0) lobby.emptySince = Date.now();
    jukebox.onMembersChanged(lobby);
    io.to(id).emit('lobby_user_left', { userId: user.id });
    if (lobby.users.size) systemMessage(lobby, `${user.username} left`);
    broadcastLobbies();
  }

  function deleteLobby(lobby) {
    io.to(lobby.id).emit('lobby_deleted', { lobbyId: lobby.id });
    for (const u of lobby.users.values()) {
      u.currentLobbyId = null;
      u.isSpeaking = false;
      if (u.status === 'in_lobby') u.status = 'online';
      const s = socketOf(u.id);
      if (s) s.leave(lobby.id);
      notifyFriends(u);
    }
    jukebox.resetLobby(lobby);
    lobbies.delete(lobby.id);
    broadcastLobbies();
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const l of Array.from(lobbies.values())) {
      if (l.users.size === 0 && l.emptySince && now - l.emptySince > LIMITS.abandonMs && !tagOnline(l.creatorTag)) deleteLobby(l);
    }
  }, 60000);
  if (sweeper.unref) sweeper.unref();

  io.on('connection', (socket) => {
    let me = null;
    const last = {};
    const allow = (key, ms) => {
      const now = Date.now();
      if (now - (last[key] || 0) < ms) return false;
      last[key] = now;
      return true;
    };
    const myLobby = () => (me && me.currentLobbyId ? lobbies.get(me.currentLobbyId) : null);

    socket.on('pv_ping', (cb) => ack(cb, Date.now()));
    jukebox.attach(socket, { me: () => me, myLobby, allow, ack });

    socket.on('register_user', (data, cb) => {
      try {
        data = data || {};
        const username = String(data.username || '').trim().slice(0, 20) || 'Guest';
        let num = parseInt(data.tag, 10);
        if (!(num >= 1000 && num <= 9999)) num = 1000 + Math.floor(Math.random() * 9000);
        let tag = `${username}#${num}`;
        for (let i = 0; i < 20; i++) {
          const clash = findUser(tag);
          if (!clash || clash.id === socket.id || clash.tag.toLowerCase() !== tag.toLowerCase()) break;
          tag = `${username}#${1000 + Math.floor(Math.random() * 9000)}`;
        }

        const friendTags = Array.isArray(data.friends) ? data.friends.slice(0, 200).map(String) : [];
        me = {
          id: socket.id, username, tag,
          avatarColor: /^#[0-9a-f]{6}$/i.test(data.avatarColor) ? data.avatarColor : '#0071e3',
          status: 'online', isMuted: false, isDeafened: false, isSpeaking: false,
          currentLobbyId: null, friends: new Set(friendTags.filter(t => t !== tag))
        };
        users.set(socket.id, me);

        const friends = [];
        for (const t of me.friends) {
          const f = findUser(t);
          if (f && f.tag === t) {
            f.friends.add(me.tag);
            friends.push(pub(f));
          } else {
            friends.push({ id: null, username: t.split('#')[0], tag: t, avatarColor: '#8e8e93', status: 'offline' });
          }
        }
        notifyFriends(me);

        ack(cb, {
          success: true, user: pub(me), lobbies: getLobbiesList(), friends,
          iceServers, serverVersion: SERVER_VERSION
        });
        broadcastLobbies();
      } catch (err) {
        ack(cb, { success: false, error: err.message });
      }
    });

    socket.on('get_lobbies', () => socket.emit('lobbies_updated', getLobbiesList()));

    // ----- lobbies -----
    socket.on('create_lobby', (data, cb) => {
      try {
        if (!me) return ack(cb, { success: false, error: 'Not registered.' });
        const name = String((data && data.name) || '').trim().slice(0, 32);
        if (!name) return ack(cb, { success: false, error: 'Lobby name is required.' });
        if (lobbies.size >= LIMITS.maxLobbies) return ack(cb, { success: false, error: 'Too many lobbies on this server.' });
        let owned = 0;
        for (const l of lobbies.values()) if (l.creatorTag === me.tag) owned++;
        if (owned >= LIMITS.lobbiesPerUser) {
          return ack(cb, { success: false, error: `You can own up to ${LIMITS.lobbiesPerUser} lobbies. Delete one first.` });
        }

        const id = 'lobby-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
        const isPrivate = !!data.isPrivate;
        lobbies.set(id, {
          id, name, isPrivate,
          password: isPrivate ? String(data.password || '').trim() : '',
          maxUsers: Math.min(Math.max(parseInt(data.maxUsers, 10) || 8, 2), 50),
          creator: me.username, creatorTag: me.tag,
          users: new Map(), messages: [], sounds: new Map(), polls: new Map(), emptySince: Date.now()
        });
        broadcastLobbies();
        ack(cb, { success: true, lobbyId: id });
      } catch (err) {
        ack(cb, { success: false, error: err.message });
      }
    });

    socket.on('join_lobby', (data, cb) => {
      try {
        if (!me) return ack(cb, { success: false, error: 'Not registered.' });
        const lobby = lobbies.get(data && data.lobbyId);
        if (!lobby) return ack(cb, { success: false, error: 'This lobby no longer exists.' });
        const isOwner = lobby.creatorTag === me.tag;
        if (lobby.isPrivate && lobby.password && !isOwner && lobby.password !== String(data.password || '')) {
          return ack(cb, { success: false, error: 'Incorrect password for this private lobby.' });
        }
        if (!lobby.users.has(socket.id) && lobby.users.size >= lobby.maxUsers) {
          return ack(cb, { success: false, error: 'Lobby is full.' });
        }

        const isNew = me.currentLobbyId !== lobby.id;
        if (isNew) leaveLobby(me);
        me.currentLobbyId = lobby.id;
        me.status = 'in_lobby';
        lobby.users.set(socket.id, me);
        lobby.emptySince = null;
        socket.join(lobby.id);

        socket.to(lobby.id).emit('lobby_user_joined', { user: pub(me) });
        if (isNew && lobby.users.size > 1) systemMessage(lobby, `${me.username} joined`);
        broadcastLobbies();
        notifyFriends(me);

        ack(cb, {
          success: true,
          lobby: lobbyInfo(lobby),
          peers: Array.from(lobby.users.values()).filter(u => u.id !== socket.id).map(pub),
          chat: lobby.messages,
          sounds: soundList(lobby),
          jukebox: jukebox.snapshot(lobby)
        });
        if (isNew) jukebox.onMembersChanged(lobby);
      } catch (err) {
        ack(cb, { success: false, error: err.message });
      }
    });

    socket.on('leave_lobby', (cb) => {
      leaveLobby(me);
      if (me) notifyFriends(me);
      ack(cb, { success: true });
    });

    socket.on('delete_lobby', (data, cb) => {
      const lobby = lobbies.get(data && data.lobbyId);
      if (!me || !lobby) return ack(cb, { success: false, error: 'Lobby not found.' });
      if (lobby.creatorTag !== me.tag) return ack(cb, { success: false, error: 'Only the creator can delete this lobby.' });
      deleteLobby(lobby);
      ack(cb, { success: true });
    });

    // ----- lobby chat -----
    socket.on('lobby_chat_send', (data, cb) => {
      const lobby = myLobby();
      if (!lobby) return ack(cb, { success: false, error: 'Join a lobby first.' });
      const text = String((data && data.text) || '').trim().slice(0, LIMITS.chatLen);
      if (!text) return ack(cb, { success: false, error: 'Empty message.' });
      if (!allow('chat', 250)) return ack(cb, { success: false, error: 'Slow down a little.' });
      pushMessage(lobby, {
        kind: 'text', id: ++seq, senderId: socket.id, senderName: me.username, senderTag: me.tag,
        avatarColor: me.avatarColor, text, ts: Date.now()
      });
      ack(cb, { success: true });
    });

    // ----- fun: dice / coin / wheel (server decides so everyone sees the same result) -----
    socket.on('fun_roll', (data, cb) => {
      const lobby = myLobby();
      if (!lobby) return ack(cb, { success: false, error: 'Join a lobby first.' });
      const type = data && data.type;
      let result, candidates, text;
      if (type === 'dice') {
        result = 1 + Math.floor(Math.random() * 6);
        text = `rolled the dice: ${result}`;
      } else if (type === 'coin') {
        result = Math.random() < 0.5 ? 'heads' : 'tails';
        text = `flipped a coin: ${result === 'heads' ? 'Heads' : 'Tails'}`;
      } else if (type === 'wheel') {
        candidates = Array.from(lobby.users.values(), u => u.username).slice(0, 12);
        if (candidates.length < 2) return ack(cb, { success: false, error: 'The wheel needs at least 2 people in the lobby.' });
        result = Math.floor(Math.random() * candidates.length);
        text = `spun the wheel: ${candidates[result]}!`;
      } else {
        return ack(cb, { success: false, error: 'Unknown game.' });
      }
      if (!allow('roll', 2500)) return ack(cb, { success: false, error: 'Wait a moment before playing again.' });
      pushMessage(lobby, {
        kind: 'roll', id: ++seq, type, result, candidates, senderId: socket.id, senderName: me.username,
        senderTag: me.tag, avatarColor: me.avatarColor, text, ts: Date.now()
      });
      ack(cb, { success: true });
    });

    // ----- fun: polls -----
    socket.on('poll_create', (data, cb) => {
      const lobby = myLobby();
      if (!lobby) return ack(cb, { success: false, error: 'Join a lobby first.' });
      const question = String((data && data.question) || '').trim().slice(0, 120);
      const options = (Array.isArray(data && data.options) ? data.options : [])
        .map(o => String(o || '').trim().slice(0, 60)).filter(Boolean).slice(0, 6);
      if (!question || options.length < 2) return ack(cb, { success: false, error: 'A poll needs a question and at least 2 options.' });
      if (!allow('poll', 3000)) return ack(cb, { success: false, error: 'Wait a moment before creating another poll.' });
      const id = ++seq;
      const msg = {
        kind: 'poll', id, pollId: 'p' + id, question, options: options.map(t => ({ text: t, votes: [] })),
        senderId: socket.id, senderName: me.username, senderTag: me.tag, avatarColor: me.avatarColor,
        text: `started a poll: ${question}`, ts: Date.now()
      };
      lobby.polls.set(msg.pollId, msg);
      pushMessage(lobby, msg);
      ack(cb, { success: true });
    });

    socket.on('poll_vote', (data, cb) => {
      const lobby = myLobby();
      const poll = lobby && lobby.polls.get(data && data.pollId);
      const idx = parseInt(data && data.option, 10);
      if (!poll || !(idx >= 0 && idx < poll.options.length)) return ack(cb, { success: false, error: 'Poll not found.' });
      if (!allow('vote', 200)) return ack(cb, { success: false, rate: true });
      const had = poll.options[idx].votes.includes(me.tag);
      poll.options.forEach(o => { o.votes = o.votes.filter(t => t !== me.tag); });
      if (!had) poll.options[idx].votes.push(me.tag); // clicking your choice again removes the vote
      io.to(lobby.id).emit('poll_update', { pollId: poll.pollId, options: poll.options });
      ack(cb, { success: true });
    });

    // ----- fun: emoji reactions (lobby or 1-on-1 call) -----
    socket.on('reaction', (data) => {
      const emoji = data && data.emoji;
      if (!me || !REACTIONS.includes(emoji) || !allow('reaction', 120)) return;
      const payload = { emoji, byId: socket.id, byName: me.username };
      if (data.targetCallPeer && users.has(data.targetCallPeer)) {
        io.to(data.targetCallPeer).emit('reaction', payload);
        socket.emit('reaction', payload);
      } else if (me.currentLobbyId) {
        io.to(me.currentLobbyId).emit('reaction', payload);
      }
    });

    // ----- typing indicators -----
    socket.on('typing', (data) => {
      if (!me || !allow('typing', 1500)) return;
      if (data && data.scope === 'dm' && users.has(data.target)) {
        io.to(data.target).emit('typing', { scope: 'dm', id: socket.id, tag: me.tag, name: me.username });
      } else if (me.currentLobbyId) {
        socket.to(me.currentLobbyId).emit('typing', { scope: 'lobby', id: socket.id, name: me.username });
      }
    });

    // ----- shared soundboard -----
    socket.on('sound_upload', (data, cb) => {
      const lobby = myLobby();
      if (!lobby) return ack(cb, { success: false, error: 'Join a lobby first.' });
      const buf = data && data.data;
      if (!Buffer.isBuffer(buf) || buf.length < 16 || buf.length > LIMITS.soundBytes || buf.toString('latin1', 0, 4) !== 'PVS1') {
        return ack(cb, { success: false, error: 'Invalid sound file.' });
      }
      if (lobby.sounds.size >= LIMITS.soundsPerLobby) {
        return ack(cb, { success: false, error: `This soundboard is full (${LIMITS.soundsPerLobby} sounds).` });
      }
      let mine = 0;
      for (const s of lobby.sounds.values()) if (s.uploaderTag === me.tag) mine++;
      if (mine >= LIMITS.soundsPerUser) {
        return ack(cb, { success: false, error: `You can add up to ${LIMITS.soundsPerUser} sounds per lobby.` });
      }
      const id = 's' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
      lobby.sounds.set(id, {
        id,
        name: String(data.name || '').trim().slice(0, 24) || 'Sound',
        duration: Math.round(Math.min(10, Math.max(0.1, Number(data.duration) || 0)) * 10) / 10,
        uploaderName: me.username,
        uploaderTag: me.tag,
        data: buf
      });
      io.to(lobby.id).emit('sounds_updated', { lobbyId: lobby.id, sounds: soundList(lobby) });
      ack(cb, { success: true, id });
    });

    socket.on('sound_get', (data, cb) => {
      const lobby = myLobby();
      const s = lobby && lobby.sounds.get(data && data.id);
      if (!s) return ack(cb, { success: false, error: 'Sound not found.' });
      ack(cb, { success: true, data: s.data });
    });

    socket.on('sound_play', (data, cb) => {
      const lobby = myLobby();
      const s = lobby && lobby.sounds.get(data && data.id);
      if (!s) return ack(cb, { success: false, error: 'Sound not found.' });
      if (!allow('sound', 500)) return ack(cb, { success: false, rate: true });
      io.to(lobby.id).emit('sound_play', { id: s.id, byId: socket.id, byName: me.username });
      ack(cb, { success: true });
    });

    socket.on('sound_delete', (data, cb) => {
      const lobby = myLobby();
      const s = lobby && lobby.sounds.get(data && data.id);
      if (!s) return ack(cb, { success: false, error: 'Sound not found.' });
      if (s.uploaderTag !== me.tag && lobby.creatorTag !== me.tag) {
        return ack(cb, { success: false, error: 'Only the uploader or the lobby creator can remove this sound.' });
      }
      lobby.sounds.delete(s.id);
      io.to(lobby.id).emit('sounds_updated', { lobbyId: lobby.id, sounds: soundList(lobby) });
      ack(cb, { success: true });
    });

    // ----- friends, calls, DMs -----
    socket.on('add_friend', (data, cb) => {
      try {
        if (!me) return ack(cb, { success: false, error: 'Not registered.' });
        const tag = String((data && data.tag) || '').trim();
        if (!tag) return ack(cb, { success: false, error: 'Enter a friend tag (e.g. Alex#1234).' });
        const target = findUser(tag);
        if (!target) return ack(cb, { success: false, error: `"${tag}" is not online on this server right now.` });
        if (target.id === socket.id) return ack(cb, { success: false, error: 'You cannot add yourself.' });

        me.friends.add(target.tag);
        target.friends.add(me.tag);
        socket.emit('friend_updated', { friend: pub(target) });
        io.to(target.id).emit('friend_updated', { friend: pub(me) });
        ack(cb, { success: true, friend: pub(target) });
      } catch (err) {
        ack(cb, { success: false, error: err.message });
      }
    });

    socket.on('start_direct_call', (data, cb) => {
      try {
        if (!me) return ack(cb, { success: false, error: 'Not registered.' });
        const target = users.get(data && data.targetSocketId);
        if (!target) return ack(cb, { success: false, error: 'Friend is offline or unreachable.' });
        if (target.status === 'in_call') return ack(cb, { success: false, error: `${target.username} is already in a call.` });

        leaveLobby(me);
        const callId = 'call-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        calls.set(callId, { id: callId, callerId: socket.id, receiverId: target.id, status: 'ringing' });
        io.to(target.id).emit('incoming_direct_call', { callId, caller: pub(me) });
        ack(cb, { success: true, callId });
      } catch (err) {
        ack(cb, { success: false, error: err.message });
      }
    });

    socket.on('respond_direct_call', (data) => {
      const call = calls.get(data && data.callId);
      if (!call || !me || call.receiverId !== socket.id) return;
      const caller = users.get(call.callerId);
      if (data.accept && caller) {
        leaveLobby(me);
        call.status = 'active';
        me.status = 'in_call';
        caller.status = 'in_call';
        io.to(call.callerId).emit('direct_call_accepted', { callId: call.id, receiver: pub(me) });
        notifyFriends(me);
        notifyFriends(caller);
      } else {
        io.to(call.callerId).emit('direct_call_declined', { callId: call.id });
        calls.delete(call.id);
      }
    });

    socket.on('end_direct_call', (data) => {
      const { callId, targetSocketId } = data || {};
      if (callId) calls.delete(callId);
      if (me) { me.status = me.currentLobbyId ? 'in_lobby' : 'online'; notifyFriends(me); }
      const other = users.get(targetSocketId);
      if (other) {
        if (other.status === 'in_call') { other.status = 'online'; notifyFriends(other); }
        io.to(other.id).emit('direct_call_ended', { callId });
      }
    });

    socket.on('send_direct_message', (data, cb) => {
      const { targetSocketId, text } = data || {};
      const body = String(text || '').trim().slice(0, 500);
      if (!me || !targetSocketId || !body || !users.has(targetSocketId)) return ack(cb, { success: false, error: 'Friend is offline.' });
      if (!allow('dm', 150)) return ack(cb, { success: false, error: 'Slow down a little.' });
      const message = { senderId: socket.id, senderName: me.username, senderTag: me.tag, text: body, timestamp: Date.now() };
      io.to(targetSocketId).emit('receive_direct_message', message);
      ack(cb, { success: true, message });
    });

    // ----- streams: a viewer asks a streamer to start/stop sending them the stream -----
    socket.on('stream_watch', (data) => {
      if (!me || !data || !users.has(data.target)) return;
      io.to(data.target).emit('stream_watch', { from: socket.id, on: !!data.on });
    });

    // ----- MSN-style nudge in private messages -----
    socket.on('nudge', (data, cb) => {
      if (!me || !data || !users.has(data.target)) return ack(cb, { success: false, error: 'Friend is offline.' });
      if (!allow('nudge', 5000)) return ack(cb, { success: false, error: 'Wait a few seconds before nudging again.' });
      io.to(data.target).emit('nudge', { from: socket.id, name: me.username, tag: me.tag });
      ack(cb, { success: true });
    });

    // ----- WebRTC + voice state -----
    socket.on('webrtc_signal', (msg) => {
      if (!msg || !msg.target || !users.has(msg.target)) return;
      io.to(msg.target).emit('webrtc_signal', { sender: socket.id, type: msg.type, payload: msg.payload });
    });

    socket.on('update_state', (state) => {
      if (!me || !state) return;
      if (state.isMuted !== undefined) me.isMuted = !!state.isMuted;
      if (state.isDeafened !== undefined) me.isDeafened = !!state.isDeafened;
      if (state.isSpeaking !== undefined) me.isSpeaking = !!state.isSpeaking;
      const streamChanged = state.isStreaming !== undefined && !!state.isStreaming !== !!me.isStreaming;
      if (state.isStreaming !== undefined) me.isStreaming = !!state.isStreaming;
      const payload = { userId: socket.id, state: { isMuted: me.isMuted, isDeafened: me.isDeafened, isSpeaking: me.isSpeaking, isStreaming: !!me.isStreaming } };
      if (streamChanged && me.currentLobbyId) {
        broadcastLobbies(); // LIVE badge in everyone's lobby list
        const lobby = lobbies.get(me.currentLobbyId);
        if (lobby && me.isStreaming) systemMessage(lobby, `${me.username} started streaming`);
      }
      if (me.currentLobbyId) socket.to(me.currentLobbyId).emit('user_state_changed', payload);
      if (state.targetCallPeer) io.to(state.targetCallPeer).emit('user_state_changed', payload);
    });

    socket.on('disconnect', () => {
      leaveLobby(me);
      for (const call of Array.from(calls.values())) {
        if (call.callerId !== socket.id && call.receiverId !== socket.id) continue;
        const otherId = call.callerId === socket.id ? call.receiverId : call.callerId;
        const other = users.get(otherId);
        if (call.status === 'ringing') {
          io.to(otherId).emit(call.callerId === socket.id ? 'direct_call_cancelled' : 'direct_call_declined', { callId: call.id });
        } else {
          if (other) { other.status = 'online'; notifyFriends(other); }
          io.to(otherId).emit('direct_call_ended', { callId: call.id });
        }
        calls.delete(call.id);
      }
      if (me) notifyFriends(me, 'offline');
      users.delete(socket.id);
      broadcastLobbies();
    });
  });

  return {
    server, io,
    start: () => new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once('error', onError);
      server.listen(port, '0.0.0.0', () => { server.off('error', onError); resolve({ port }); });
    }),
    stop: () => new Promise((resolve) => {
      clearTimeout(lobbiesTimer);
      clearInterval(sweeper);
      jukebox.stop(lobbies);
      try { io.close(() => resolve()); } catch (e) { resolve(); }
    })
  };
}

function getLocalIpAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const k in ifaces) {
    for (const a of ifaces[k]) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

if (require.main === module) {
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  createSignalingServer(PORT).start().then(({ port }) => {
    console.log(`\n  PelakaVoice server ${SERVER_VERSION} is running`);
    console.log(`  Local:  http://127.0.0.1:${port}`);
    getLocalIpAddresses().forEach(ip => console.log(`  LAN:    http://${ip}:${port}`));
    console.log(`  Status: http://127.0.0.1:${port}/status\n`);
  }).catch(err => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : 'Server startup error: ' + err.message);
    process.exit(1);
  });
}

module.exports = { createSignalingServer, getLocalIpAddresses, compareVersions, SERVER_VERSION };
