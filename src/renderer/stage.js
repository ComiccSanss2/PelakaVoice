// PelakaVoice stage: several streams at once (each with its own tile + sound volume), home screen with
// live activity ticker, call timer, collapsible chat / soundboard, soundboard hotkeys, MSN-style nudges
(function () {
  const pv = () => window.pv;
  const $ = (id) => document.getElementById(id);
  const api = window.electronAPI || {};
  let socket = null;

  // ======================= STREAMS =======================
  // peerId -> { tile, video, name, tag, watching, playing, timer }
  const streams = new Map();
  const everWatched = new Set(); // tags we watched this session: re-watch automatically when they go live again
  let selfTile = null;

  const autoWatch = () => localStorage.getItem('pv_autowatch') !== '0';
  const grid = () => (pv().state.inDirectCall ? $('direct-stream-grid') : $('stream-grid'));

  function peerInfo(id) {
    const st = pv().state;
    return st.lobbyPeers.get(id) || (st.directCallPartner && st.directCallPartner.id === id ? st.directCallPartner : null);
  }

  function streamVolume(tag) {
    const v = parseFloat(localStorage.getItem('pv_svol_' + tag));
    return v >= 0 && v <= 1 ? v : 0.8;
  }

  function applyAudio(s) {
    const eng = pv().state.audioEngine;
    s.video.volume = streamVolume(s.tag);
    s.video.muted = eng.isDeafened || s.self;
    if (eng.sinkId && s.video.setSinkId) s.video.setSinkId(eng.sinkId).catch(() => {});
  }

  function updateLayout() {
    const count = streams.size + (selfTile ? 1 : 0);
    ['stream-grid', 'direct-stream-grid'].forEach(id => {
      const g = $(id);
      g.dataset.count = String(g.childElementCount);
    });
    document.querySelector('.lobby-main').classList.toggle('has-streams', count > 0 && !pv().state.inDirectCall);
  }

  function makeTile(name, self) {
    const tile = document.createElement('div');
    tile.className = 'stream-tile' + (self ? ' self' : '');
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="st-idle">
        <span class="st-live-big">● LIVE</span>
        <strong class="st-idle-name"></strong>
        <button type="button" class="btn-primary st-watch">▶ Watch stream</button>
      </div>
      <div class="st-loading"><span class="spinner"></span><span>Connecting to the stream…</span></div>
      <div class="st-bar">
        <span class="st-badge">● LIVE</span>
        <span class="st-name"></span>
        <span class="st-stats"></span>
        <div class="st-controls">
          ${self ? '' : '<span class="st-vol-ic" title="Stream volume">🔊</span><input type="range" class="st-vol" min="0" max="100" title="Stream volume (game / video sound)">'}
          <button type="button" class="st-btn st-focus" title="Focus (make it big)">⤢</button>
          <button type="button" class="st-btn st-full" title="Fullscreen (F)">⛶</button>
          <button type="button" class="st-btn st-close" title="${self ? 'Stop streaming' : 'Stop watching'}">✕</button>
        </div>
      </div>
      <div class="st-scan"></div>`;
    tile.querySelector('.st-name').textContent = name;
    tile.querySelector('.st-idle-name').textContent = `${name} is streaming`;
    tile.querySelector('.st-full').addEventListener('click', () => fullscreen(tile));
    tile.querySelector('video').addEventListener('dblclick', () => fullscreen(tile));
    tile.querySelector('.st-focus').addEventListener('click', () => {
      const on = !tile.classList.contains('focus');
      tile.parentElement.querySelectorAll('.stream-tile.focus').forEach(t => t.classList.remove('focus'));
      tile.classList.toggle('focus', on);
    });
    return tile;
  }

  function fullscreen(tile) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else tile.requestFullscreen().catch(() => {});
  }

  function setTileState(s, mode) { // idle | loading | playing
    s.tile.dataset.mode = mode;
    clearTimeout(s.timer);
    if (mode === 'loading') {
      s.timer = setTimeout(() => { if (s.tile.dataset.mode === 'loading') setTileState(s, 'idle'); }, 12000);
    }
  }

  function ensureStream(peerId) {
    let s = streams.get(peerId);
    if (s) return s;
    const peer = peerInfo(peerId) || {};
    const tile = makeTile(peer.username || 'Someone', false);
    s = { tile, video: tile.querySelector('video'), name: peer.username || 'Someone', tag: peer.tag || peerId, watching: false, timer: null, self: false };
    streams.set(peerId, s);
    const vol = tile.querySelector('.st-vol');
    vol.value = Math.round(streamVolume(s.tag) * 100);
    vol.addEventListener('input', () => {
      localStorage.setItem('pv_svol_' + s.tag, String(vol.value / 100));
      applyAudio(s);
    });
    tile.querySelector('.st-watch').addEventListener('click', () => watch(peerId, true));
    tile.querySelector('.st-close').addEventListener('click', () => watch(peerId, false));
    setTileState(s, 'idle');
    grid().appendChild(tile);
    updateLayout();
    return s;
  }

  function watch(peerId, on) {
    const s = streams.get(peerId);
    if (!s || !socket) return;
    s.watching = on;
    if (on) everWatched.add(s.tag);
    else everWatched.delete(s.tag);
    socket.emit('stream_watch', { target: peerId, on });
    if (on && s.video.srcObject && s.tile.dataset.mode === 'playing') return;
    setTileState(s, on ? 'loading' : 'idle');
    if (!on) s.tile.classList.remove('focus');
  }

  function dropStream(peerId) {
    const s = streams.get(peerId);
    if (!s) return;
    clearTimeout(s.timer);
    s.video.srcObject = null;
    s.tile.classList.add('leaving');
    setTimeout(() => { s.tile.remove(); updateLayout(); }, 250);
    streams.delete(peerId);
  }

  function clearStreams() {
    Array.from(streams.keys()).forEach(dropStream);
    if (selfTile) { selfTile.remove(); selfTile = null; }
    updateLayout();
  }

  // A peer started / stopped streaming
  function liveChanged(peerId, live) {
    if (!live) { dropStream(peerId); return; }
    const s = ensureStream(peerId);
    if (autoWatch() || everWatched.has(s.tag) || pv().state.inDirectCall) watch(peerId, true);
  }

  const api2 = {
    // ---- called by app.js ----
    remoteVideo(peerId, stream) {
      const s = ensureStream(peerId);
      if (s.video.srcObject !== stream) s.video.srcObject = stream; // contains the stream's sound too
      applyAudio(s);
      s.video.play().catch(() => {});
      setTileState(s, 'playing');
    },
    remoteVideoGone(peerId) {
      const s = streams.get(peerId);
      if (!s) return;
      const peer = peerInfo(peerId);
      if (peer && peer.isStreaming) setTileState(s, s.watching ? 'loading' : 'idle');
      else dropStream(peerId);
    },
    stats(peerId, st) {
      const s = streams.get(peerId);
      if (s && st.h) s.tile.querySelector('.st-stats').textContent = `${st.h}p · ${st.fps} fps · ${st.rtt} ms`;
    },
    peerState(peerId, st) {
      if (st.isStreaming === undefined) return;
      const has = streams.has(peerId);
      if (st.isStreaming && !has) liveChanged(peerId, true);
      else if (!st.isStreaming && has) liveChanged(peerId, false);
    },
    peerLeft(peerId) { dropStream(peerId); },
    local(stream, prof) {
      const st = pv().state;
      if (selfTile) selfTile.remove();
      selfTile = makeTile('You', true);
      const v = selfTile.querySelector('video');
      v.muted = true;
      v.srcObject = stream;
      selfTile.dataset.mode = 'playing';
      selfTile.querySelector('.st-stats').textContent = `${prof && prof.h ? prof.h + 'p' : ''} · ${stream.getAudioTracks().length ? 'with sound' : 'no sound'} · 0 watching`;
      selfTile.querySelector('.st-close').addEventListener('click', () => {
        const btn = pv().el.dockBtnScreen;
        if (st.isSharingScreen) btn.click();
      });
      grid().prepend(selfTile);
      updateLayout();
      if (socket) socket.emit('update_state', { isStreaming: true, targetCallPeer: st.inDirectCall && st.directCallPartner ? st.directCallPartner.id : null });
    },
    localStop() {
      const st = pv().state;
      if (selfTile) { selfTile.remove(); selfTile = null; }
      updateLayout();
      if (socket) socket.emit('update_state', { isStreaming: false, targetCallPeer: st.inDirectCall && st.directCallPartner ? st.directCallPartner.id : null });
    },
    onEnterLobby(peers) {
      clearStreams();
      peers.forEach(p => { if (p.isStreaming) liveChanged(p.id, true); });
      timerStart();
    },
    onDirectCall(partner) {
      clearStreams();
      if (partner && partner.isStreaming) liveChanged(partner.id, true);
      timerStart();
    },
    onExit() {
      clearStreams();
      timerStop();
    },
    onLogin(server) {
      pv().state.audioEngine.playTone([523, 659, 784, 1047], 'sine', 0.11, 0.07); // sign-in jingle
      if (window.pvHost) window.pvHost.remember(server);
      renderHero();
    },
    attach(s) {
      socket = s;
      s.on('stream_watch', ({ from, on }) => {
        const st = pv().state;
        st.webrtc.setPeerWatching(from, on);
        if (selfTile && st.isSharingScreen) {
          const n = st.webrtc.watchers();
          const stats = selfTile.querySelector('.st-stats');
          stats.textContent = stats.textContent.replace(/\d+ watching/, `${n} watching`);
        }
        const peer = peerInfo(from);
        if (on && peer) pv().toast(`${peer.username} is watching your stream`, 'ok');
      });
      s.on('lobbies_updated', (lobbies) => { feed(lobbies); setTimeout(renderHero, 0); }); // after app.js stored the list
      s.on('lobby_chat', () => {
        if (!$('active-lobby-stage').querySelector('.lobby-body').classList.contains('chat-collapsed')) return;
        unread++;
        $('chat-unread').textContent = unread > 99 ? '99+' : String(unread);
        $('chat-unread').classList.remove('hidden');
      });
      s.on('nudge', ({ name }) => {
        if (api.shakeWindow) api.shakeWindow();
        const app = pv().el.appScreen;
        app.classList.remove('nudged');
        void app.offsetWidth;
        app.classList.add('nudged');
        pv().state.audioEngine.playTone([220, 196, 220, 196, 220], 'square', 0.07, 0.05);
        pv().toast(`📳 ${name} sent you a nudge!`);
        if (window.pvQol) window.pvQol.notify(`${name} sent you a nudge!`, '📳 Bzzz', true);
      });
    }
  };

  // ======================= CALL TIMER (LCD) + presence for the tray =======================
  let callStart = 0;
  let wasInCall = false;
  function timerStart() {
    if (!callStart) callStart = Date.now();
    $('call-timer').classList.remove('hidden');
  }
  function timerStop() {
    const st = pv().state;
    if (st.currentLobby || st.inDirectCall) return; // still in another call
    callStart = 0;
    $('call-timer').classList.add('hidden');
  }
  setInterval(() => {
    const st = pv().state;
    const inCall = !!(st.currentLobby || st.inDirectCall);
    if (inCall !== wasInCall) {
      wasInCall = inCall;
      if (api.setPresence) api.setPresence(inCall);
      if (!inCall) { callStart = 0; $('call-timer').classList.add('hidden'); }
    }
    if (!callStart) return;
    const t = Math.floor((Date.now() - callStart) / 1000);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    $('call-timer').textContent = (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(sec).padStart(2, '0');
  }, 1000);

  // Voice meter in the dock follows your own voice
  (function hookSpeaking() {
    const eng = pv().state.audioEngine;
    const orig = eng.onSpeakingChange;
    eng.onSpeakingChange = (speaking) => {
      if (orig) orig(speaking);
      $('dock-viz').classList.toggle('on', speaking);
    };
    eng.onDeafenChange = () => streams.forEach(applyAudio);
  })();

  // ======================= HOME (hero) + live activity ticker =======================
  const events = [];
  let prev = null;
  function feed(lobbies) {
    const now = new Map(lobbies.map(l => [l.id, l]));
    if (prev) {
      const add = (t) => { events.push(t); if (events.length > 10) events.shift(); };
      now.forEach((l, id) => {
        const old = prev.get(id);
        if (!old) { add(`✨ ${l.creator} opened “${l.name}”`); return; }
        const before = new Map(old.users.map(u => [u.id, u]));
        l.users.forEach(u => {
          const was = before.get(u.id);
          if (!was) add(`👋 ${u.username} joined ${l.name}`);
          else if (u.isStreaming && !was.isStreaming) add(`🔴 ${u.username} is live in ${l.name}`);
        });
        old.users.forEach(u => { if (!l.users.some(x => x.id === u.id)) add(`🚪 ${u.username} left ${l.name}`); });
      });
      prev.forEach((l, id) => { if (!now.has(id)) add(`🌙 “${l.name}” was closed`); });
    }
    prev = now;
    renderTicker();
  }

  function renderTicker() {
    const items = events.length ? events.slice().reverse() : ['Welcome to PelakaVoice', 'Create a lobby and invite your friends', 'Press 1–9 to play soundboard sounds', 'Ctrl+Shift+M mutes you even inside games'];
    const box = $('ticker-items');
    const text = items.join('   ✦   ') + '   ✦   ';
    if (box.dataset.text === text) return;
    box.dataset.text = text;
    box.textContent = text + text; // doubled for a seamless loop
    box.style.animationDuration = Math.max(18, text.length * 0.22) + 's';
  }

  function inviteText() {
    const url = pv().state.serverUrl || '';
    const m = /^https:\/\/([a-z0-9-]+)\.trycloudflare\.com/i.exec(url);
    return m ? m[1] : url.replace(/^https?:\/\//, '');
  }

  function renderHero() {
    const st = pv().state;
    const h = new Date().getHours();
    $('hero-greeting').textContent = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    $('hero-name').textContent = st.username || 'friend';
    const lobbies = st.lobbies || [];
    let online = 0, live = 0, best = null;
    lobbies.forEach(l => {
      online += l.userCount;
      live += l.users.filter(u => u.isStreaming).length;
      if (!best || l.userCount > best.userCount) best = l;
    });
    $('stat-lobbies').textContent = lobbies.length;
    $('stat-online').textContent = online;
    $('stat-live').textContent = live;
    $('hero-sub').textContent = lobbies.length
      ? (live ? `${live} stream${live === 1 ? ' is' : 's are'} live right now — pick a lobby on the left.` : 'Pick a lobby on the left, or start your own.')
      : 'It\'s quiet here… create the first lobby and invite your friends.';
    $('hero-join-sub').textContent = best && best.userCount ? `${best.name} · ${best.userCount} inside` : (best ? `Open ${best.name}` : 'No lobby yet');
    $('hero-join').disabled = !best;
    $('hero-join').dataset.lobby = best ? best.id : '';
    $('hero-invite-sub').textContent = inviteText() || 'Copy this server\'s invite';
    $('hero-version').textContent = st.appVersion ? 'v' + st.appVersion : '';
  }

  function setupHero() {
    $('hero-create').addEventListener('click', () => $('btn-open-create-lobby').click());
    $('hero-join').addEventListener('click', () => {
      const id = $('hero-join').dataset.lobby;
      const idx = (pv().state.lobbies || []).findIndex(l => l.id === id);
      const card = document.querySelectorAll('#lobbies-grid .lobby-card')[idx];
      if (card) card.querySelector('.btn-join-lobby').click();
    });
    $('hero-invite').addEventListener('click', () => {
      const t = inviteText();
      if (t) navigator.clipboard.writeText(t).then(() => pv().toast('Invite copied — send it to your friends', 'ok')).catch(() => {});
    });
    setInterval(renderHero, 60000);
    renderTicker();
  }

  // ======================= chat + soundboard collapse, hotkeys, nudge, tagline =======================
  let unread = 0;
  function setupPanels() {
    const body = document.querySelector('#active-lobby-stage .lobby-body');
    const setChat = (collapsed) => {
      body.classList.toggle('chat-collapsed', collapsed);
      localStorage.setItem('pv_chat_collapsed', collapsed ? '1' : '0');
      $('btn-toggle-chat').classList.toggle('active', !collapsed);
      if (!collapsed) { unread = 0; $('chat-unread').classList.add('hidden'); }
    };
    setChat(localStorage.getItem('pv_chat_collapsed') === '1');
    $('btn-toggle-chat').addEventListener('click', () => setChat(!body.classList.contains('chat-collapsed')));

    const sb = document.querySelector('.soundboard-section');
    sb.classList.toggle('collapsed', localStorage.getItem('pv_sb_collapsed') === '1');
    $('btn-sb-collapse').addEventListener('click', () => {
      sb.classList.toggle('collapsed');
      localStorage.setItem('pv_sb_collapsed', sb.classList.contains('collapsed') ? '1' : '0');
    });

    const aw = $('check-autowatch');
    aw.checked = autoWatch();
    aw.addEventListener('change', () => localStorage.setItem('pv_autowatch', aw.checked ? '1' : '0'));

    // 1–9 play soundboard sounds, F fullscreens the first stream
    window.addEventListener('keydown', (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const st = pv().state;
      if (!st.currentLobby || e.code === st.pttKey) return;
      const d = /^Digit([1-9])$/.exec(e.code);
      if (d) {
        const btn = document.querySelectorAll('#sound-grid .sound-btn')[parseInt(d[1], 10) - 1];
        if (btn) btn.click();
      } else if (e.code === 'KeyF') {
        const t = document.querySelector('.stream-tile[data-mode="playing"]');
        if (t) fullscreen(t);
      }
    });

    // Nudge (MSN style)
    $('btn-nudge').addEventListener('click', () => {
      const f = st().selectedFriend;
      if (!socket || !f || !f.id) { pv().toast('Your friend is offline.'); return; }
      socket.emit('nudge', { target: f.id }, (r) => {
        if (r && r.success) pv().toast(`📳 You nudged ${f.username}`, 'ok');
        else pv().toast((r && r.error) || 'Could not nudge.');
      });
    });
  }
  const st = () => pv().state;

  // Retro typewriter tagline on the login card
  function typewriter() {
    const el = $('login-tagline');
    const text = el.textContent;
    el.textContent = '';
    let i = 0;
    const tick = () => {
      el.textContent = text.slice(0, ++i);
      if (i < text.length) setTimeout(tick, 28 + Math.random() * 40);
      else el.classList.add('done');
    };
    setTimeout(tick, 650);
  }

  // ======================= "What's new" popup after an update =======================
  const WHATS_NEW = [
    '📺 Watch several streams at once — and go live together',
    '🔊 Stream sound (games, videos) without your friends\' voices, with its own volume',
    '🖥️ Host your server from Settings → Your server: no .bat window, keeps running in the tray',
    '🧭 New layout: lobby list on the left, home screen with live feed, collapsible chat',
    '📳 MSN-style nudges, ⏱️ call timer, 1–9 soundboard keys, recent servers on login'
  ];
  async function whatsNew() {
    if (!api.getAppVersion) return;
    const version = await api.getAppVersion();
    const last = localStorage.getItem('pv_last_version');
    localStorage.setItem('pv_last_version', version);
    const existingUser = last || localStorage.getItem('pv_nick');
    if (!existingUser || last === version) return;
    const info = api.whatsNew ? await api.whatsNew() : null;
    $('whats-new-title').textContent = `Updated to PelakaVoice ${version}`;
    $('whats-new-notes').textContent = (info && info.notes) || 'Here is what\'s new:';
    const list = $('whats-new-list');
    list.innerHTML = '';
    WHATS_NEW.forEach(t => { const li = document.createElement('li'); li.textContent = t; list.appendChild(li); });
    $('modal-whats-new').classList.remove('hidden');
    setTimeout(() => { if (window.pvFun) window.pvFun.confetti(window.innerWidth / 2, window.innerHeight / 2 - 60, 50); }, 350);
  }

  window.pvStage = api2;
  whatsNew();
  setupHero();
  setupPanels();
  typewriter();
})();
