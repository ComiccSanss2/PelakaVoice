// PelakaVoice JukeBox (client): paste a YouTube link, everyone in the lobby hears it in sync.
// Anyone can queue tracks; pause / skip / shared volume need a majority of the people in voice.
// "Your volume" is local only and needs no vote.
(function () {
  const pv = () => window.pv;
  const $ = (id) => document.getElementById(id);
  const VOTE_LABEL = { skip: 'skip this track', pause: 'pause', resume: 'resume', volume: 'set the volume to' };

  let socket = null;
  let st = null;          // last jb_state from the server
  let offset = 0;         // server clock - local clock (ms)
  let supported = true;
  let audio = null;
  let loadedId = null;
  let waitTimer = null;
  let personal = parseFloat(localStorage.getItem('pv_jb_vol'));
  if (!(personal >= 0 && personal <= 1)) personal = 0.8;

  // ---------- helpers ----------
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
  };
  const myTag = () => pv().state.tag;
  const lobby = () => pv().state.currentLobby;
  const base = () => String(pv().state.serverUrl || '').replace(/\/+$/, '');
  const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  const now = () => Date.now() + offset;

  function emit(ev, data, cb) {
    if (!socket) return;
    socket.timeout(10000).emit(ev, data, (err, res) => {
      if (err) return pv().toast('The server did not answer. Its host may need PelakaVoice 2.4 for the JukeBox.');
      if (res && !res.success && !res.rate && res.error) pv().toast(res.error);
      if (cb) cb(res);
    });
  }

  function position() {
    if (!st || !st.current) return 0;
    return st.paused ? st.pausePos : (now() - st.startedAt) / 1000;
  }

  // ---------- playback ----------
  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('error', () => {
      if (loadedId && st && st.current && st.current.id === loadedId) setTimeout(() => { loadedId = null; sync(); }, 1500);
    });
    return audio;
  }

  function applyVolume() {
    if (!audio) return;
    const eng = pv().state.audioEngine;
    const deaf = !!(eng && eng.isDeafened);
    audio.muted = deaf;
    audio.volume = Math.max(0, Math.min(1, (st ? st.volume : 0.6) * personal));
    const sink = eng && eng.sinkId;
    if (audio.setSinkId && (audio.sinkId || '') !== (sink || '')) audio.setSinkId(sink || '').catch(() => {});
  }

  function stopAudio() {
    clearTimeout(waitTimer);
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    loadedId = null;
  }

  function sync() {
    clearTimeout(waitTimer);
    if (!st || !st.current || st.current.status !== 'ready' || !lobby()) return stopAudio();
    const a = ensureAudio();
    applyVolume();
    if (loadedId !== st.current.id) {
      loadedId = st.current.id;
      a.src = `${base()}/jukebox/${encodeURIComponent(st.current.id)}`;
    }
    const pos = position();
    if (st.paused) {
      a.pause();
      if (Math.abs(a.currentTime - pos) > 0.3) a.currentTime = pos;
      return;
    }
    if (pos < 0) { // the track starts in a moment: everyone presses play together
      a.pause();
      if (a.currentTime > 0.05) a.currentTime = 0;
      waitTimer = setTimeout(sync, Math.min(-pos * 1000, 5000));
      return;
    }
    if (st.current.duration && pos > st.current.duration + 1) { a.pause(); return; }
    if (Math.abs(a.currentTime - pos) > 0.4) a.currentTime = pos;
    if (a.paused) a.play().catch(() => {});
  }

  // Gentle drift correction + progress UI
  setInterval(() => {
    if (!st || !st.current) return;
    applyVolume();
    if (audio && !st.paused && loadedId === st.current.id && audio.readyState >= 2) {
      const pos = position();
      if (pos >= 0 && Math.abs(audio.currentTime - pos) > 0.6) audio.currentTime = pos;
      if (pos >= 0 && audio.paused && !audio.ended) audio.play().catch(() => {});
    }
    updateProgress();
    updateVoteTimers();
  }, 500);

  // ---------- rendering ----------
  function voteFor(kind) {
    const v = st && st.votes && st.votes[kind];
    return v && v.expires > now() ? v : null;
  }

  function voteChip(kind) {
    const v = voteFor(kind);
    if (!v) return '';
    const mine = v.voters.includes(myTag());
    return `<span class="jb-votes${mine ? ' mine' : ''}" data-exp="${v.expires}">${v.voters.length}/${st.need}</span>`;
  }

  function renderNow() {
    const box = $('jb-now');
    if (!supported) {
      box.innerHTML = '<div class="jb-empty">This server doesn\'t have the JukeBox yet. The host needs PelakaVoice 2.4 or newer.</div>';
      return;
    }
    if (!st || !st.current) {
      const loading = st && st.queue.some(t => t.status === 'loading');
      box.innerHTML = `<div class="jb-empty">${loading
        ? '<span class="jb-spin"></span> Getting the audio from YouTube…'
        : 'Nothing playing. Paste a YouTube link above — everyone in the lobby hears it, in sync.'}</div>`;
      return;
    }
    const t = st.current;
    const pauseAction = st.paused ? 'resume' : 'pause';
    const volV = voteFor('volume');
    const vol = Math.round(st.volume * 100);
    box.innerHTML = `
      <div class="jb-card${st.paused ? ' paused' : ''}">
        <div class="jb-art" style="background-image:url('${thumb(t.videoId)}')"><div class="jb-eq"><i></i><i></i><i></i><i></i></div></div>
        <div class="jb-info">
          <div class="jb-kicker">${st.paused ? 'Paused' : 'Now playing'}</div>
          <div class="jb-title"></div>
          <div class="jb-sub"></div>
          <div class="jb-progress"><div class="jb-bar"><div class="jb-fill" id="jb-fill"></div></div><span class="jb-time" id="jb-time"></span></div>
          <div class="jb-controls">
            <button type="button" class="jb-btn${voteFor('pause') ? ' voting' : ''}" data-act="${pauseAction}">${st.paused ? '▶ Resume' : '⏸ Pause'}${voteChip('pause')}</button>
            <button type="button" class="jb-btn${voteFor('skip') ? ' voting' : ''}" data-act="skip">⏭ Skip${voteChip('skip')}</button>
            <div class="jb-vol" title="Shared volume (everyone) — changes need a vote">
              <button type="button" class="jb-btn sm" data-act="vol-down" ${vol <= 0 ? 'disabled' : ''}>−</button>
              <span class="jb-vol-val">🔊 ${vol}%</span>
              <button type="button" class="jb-btn sm" data-act="vol-up" ${vol >= 100 ? 'disabled' : ''}>+</button>
            </div>
            ${volV ? `<button type="button" class="jb-btn voting" data-act="vol-agree">Volume → ${Math.round(volV.value * 100)}%${voteChip('volume')}</button>` : ''}
            <label class="jb-mine" title="Only for you, no vote needed">🎧 <input type="range" id="jb-personal" min="0" max="100" value="${Math.round(personal * 100)}"></label>
          </div>
          <div class="jb-hint" id="jb-hint"></div>
        </div>
      </div>`;
    box.querySelector('.jb-title').textContent = t.title;
    box.querySelector('.jb-sub').textContent = `${t.uploader ? t.uploader + ' · ' : ''}added by ${t.byName}`;
    updateHint();
    updateProgress();
  }

  function updateHint() {
    const h = $('jb-hint');
    if (!h || !st) return;
    const open = ['skip', 'pause', 'volume'].map(k => [k, voteFor(k)]).filter(x => x[1]);
    if (!open.length) {
      h.textContent = st.need > 1
        ? `Pause, skip and the shared volume need a majority: ${st.need} of ${st.members} people in voice.`
        : 'You\'re alone in voice, so your votes pass right away.';
      h.classList.remove('active');
      return;
    }
    const [kind, v] = open[0];
    const what = kind === 'volume' ? `${VOTE_LABEL.volume} ${Math.round(v.value * 100)}%` : VOTE_LABEL[v.action];
    const mine = v.voters.includes(myTag());
    h.textContent = `${v.byName} wants to ${what} — ${v.voters.length}/${st.need} votes${mine ? '' : ' · click the button to agree'}`;
    h.classList.add('active');
  }

  function renderQueue() {
    const list = $('jb-queue');
    const p = pv();
    list.innerHTML = '';
    $('jb-count').textContent = st && st.queue.length ? `${st.queue.length} in queue` : '';
    if (!st || !st.queue.length) return;
    const owner = lobby() && lobby().creatorTag === myTag();
    const head = document.createElement('div');
    head.className = 'jb-qhead';
    head.textContent = 'Up next';
    list.appendChild(head);
    st.queue.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'jb-item' + (t.status === 'loading' ? ' loading' : '');
      row.innerHTML = `
        <span class="jb-n">${i + 1}</span>
        <span class="jb-thumb" style="background-image:url('${thumb(t.videoId)}')"></span>
        <span class="jb-itext"><span class="jb-ititle"></span><span class="jb-imeta"></span></span>
        ${t.byTag === myTag() || owner ? '<button type="button" class="sound-del jb-del" title="Remove from queue">&times;</button>' : ''}`;
      row.querySelector('.jb-ititle').textContent = t.title;
      row.querySelector('.jb-imeta').innerHTML = t.status === 'loading'
        ? '<span class="jb-spin"></span> downloading · ' + p.escapeHtml(t.byName)
        : `${fmt(t.duration)} · ${p.escapeHtml(t.byName)}`;
      const del = row.querySelector('.jb-del');
      if (del) del.addEventListener('click', () => emit('jb_remove', { id: t.id }));
      list.appendChild(row);
    });
  }

  function render() {
    renderNow();
    renderQueue();
    const sec = $('jukebox-section');
    sec.classList.toggle('playing', !!(st && st.current && !st.paused));
    $('input-jb-url').disabled = !supported;
    $('btn-jb-add').disabled = !supported;
  }

  function updateProgress() {
    const fill = $('jb-fill'), time = $('jb-time');
    if (!fill || !st || !st.current) return;
    const d = st.current.duration || 0;
    const pos = Math.max(0, Math.min(d || Infinity, position()));
    fill.style.transform = `scaleX(${d ? Math.min(1, pos / d) : 0})`;
    time.textContent = `${fmt(pos)} / ${fmt(d)}`;
  }

  function updateVoteTimers() {
    if (!st || !st.votes) return;
    let expired = false;
    for (const k in st.votes) if (st.votes[k].expires <= now()) { delete st.votes[k]; expired = true; }
    if (expired) renderNow();
  }

  // ---------- events ----------
  function onState(s) {
    const l = lobby();
    if (!l || !s || s.lobbyId !== l.id) return;
    offset = s.serverNow - Date.now();
    st = s;
    supported = true;
    const active = document.activeElement;
    const sliding = active && active.id === 'jb-personal';
    if (!sliding) render(); else renderQueue();
    sync();
  }

  function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || !st) return;
    const act = b.dataset.act;
    const toggle = { toggle: true };
    if (act === 'skip' || act === 'pause' || act === 'resume') emit('jb_vote', { action: act, ...toggle });
    else if (act === 'vol-up' || act === 'vol-down') {
      const v = voteFor('volume');
      const from = v ? v.value : st.volume;
      const value = Math.round(Math.max(0, Math.min(1, from + (act === 'vol-up' ? 0.1 : -0.1))) * 10) / 10;
      emit('jb_vote', { action: 'volume', value });
    } else if (act === 'vol-agree') {
      const v = voteFor('volume');
      if (v) emit('jb_vote', { action: 'volume', value: v.value, ...toggle });
    }
  }

  function add() {
    const input = $('input-jb-url');
    const url = input.value.trim();
    if (!url) return input.focus();
    if (!lobby()) return pv().toast('Join a lobby first.');
    const btn = $('btn-jb-add');
    btn.disabled = true;
    emit('jb_add', { url }, (res) => {
      btn.disabled = !supported;
      if (res && res.success) { input.value = ''; pv().toast('Added to the JukeBox — downloading the audio…', 'ok'); }
    });
  }

  function setup() {
    const sec = $('jukebox-section');
    sec.classList.toggle('collapsed', localStorage.getItem('pv_jb_collapsed') === '1');
    $('btn-jb-collapse').addEventListener('click', () => {
      sec.classList.toggle('collapsed');
      localStorage.setItem('pv_jb_collapsed', sec.classList.contains('collapsed') ? '1' : '0');
    });
    $('btn-jb-add').addEventListener('click', add);
    $('input-jb-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    $('input-jb-url').addEventListener('paste', () => setTimeout(() => {
      const v = $('input-jb-url').value;
      if (/youtu\.?be/i.test(v) && v.length < 200) add(); // paste a link = add it
    }, 0));
    $('jb-now').addEventListener('click', onClick);
    $('jb-now').addEventListener('input', (e) => {
      if (e.target.id !== 'jb-personal') return;
      personal = e.target.value / 100;
      localStorage.setItem('pv_jb_vol', String(personal));
      applyVolume();
    });
    render();
  }

  // ---------- API used by app.js ----------
  function attach(s) {
    socket = s;
    s.on('jb_state', onState);
    s.on('jb_error', ({ error }) => pv().toast('JukeBox: ' + error));
  }

  function onEnter(snapshot) {
    stopAudio();
    st = null;
    supported = !!snapshot;
    if (snapshot) onState(snapshot); else render();
  }

  function onExit() {
    st = null;
    stopAudio();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup); else setup();
  window.pvJukebox = {
    attach, onEnter, onExit,
    // read-only snapshot, handy for debugging and automated tests
    debug: () => ({ state: st, time: audio ? audio.currentTime : null, playing: !!(audio && !audio.paused), volume: audio ? audio.volume : null, position: position() })
  };
})();
