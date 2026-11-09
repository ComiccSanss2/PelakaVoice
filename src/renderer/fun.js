// PelakaVoice fun & chat extras: emoji reactions, dice / coin / wheel, polls, voice effects,
// typing indicators, clickable links, @mentions
(function () {
  const pv = () => window.pv;
  const $ = (id) => document.getElementById(id);
  const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
  const COLORS = ['#7c5cff', '#22d3ee', '#f472b6', '#f59e0b', '#34d399', '#60a5fa', '#f87171', '#a78bfa', '#2dd4bf', '#fb923c', '#e879f9', '#4ade80'];
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  const DICE_ROT = { 1: [0, 0], 2: [90, 0], 3: [0, -90], 4: [0, 90], 5: [-90, 0], 6: [0, 180] };
  const FX_NAMES = { normal: 'Normal voice', robot: 'Robot', chipmunk: 'Chipmunk', deep: 'Deep', radio: 'Radio', cave: 'Cave' };

  let socket = null;
  let rollTimer = null;
  let lastTyping = 0;
  const typers = { lobby: new Map(), dm: new Map() };

  // ---------- text helpers (used by app.js for every chat message) ----------
  function openUrl(url) {
    if (window.electronAPI && window.electronAPI.openExternal) window.electronAPI.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  }

  function fillText(node, text) {
    node.textContent = '';
    text = String(text || '');
    let last = 0;
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text))) {
      const url = m[0].replace(/[.,!?;:)\]]+$/, '');
      if (m.index > last) node.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.className = 'chat-link';
      a.href = '#';
      a.textContent = url;
      a.title = 'Open in your browser';
      a.addEventListener('click', (e) => { e.preventDefault(); openUrl(url); });
      node.appendChild(a);
      last = m.index + url.length;
      URL_RE.lastIndex = last;
    }
    if (last < text.length) node.appendChild(document.createTextNode(text.slice(last)));
  }

  function mentionsMe(m) {
    const st = pv().state;
    if (!st.username || !m.text || m.senderTag === st.tag) return false;
    const name = st.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('@' + name + '(?![\\w])', 'i').test(m.text) || /@(everyone|here)\b/i.test(m.text);
  }

  // ---------- special chat messages ----------
  function rollText(m) {
    if (m.type === 'dice') return `Rolled a ${m.result}`;
    if (m.type === 'coin') return m.result === 'heads' ? 'Heads!' : 'Tails!';
    if (m.type === 'wheel') return `The wheel picked ${(m.candidates || [])[m.result] || '?'}`;
    return m.text || '';
  }

  function renderMsg(m) {
    const { escapeHtml, safeColor, fmtTime } = pv();
    if (m.kind === 'system') {
      const d = document.createElement('div');
      d.className = 'lchat-system';
      d.textContent = m.text;
      return d;
    }
    const row = document.createElement('div');
    row.className = 'lchat-msg';
    row.innerHTML = `
      <div class="lchat-avatar" style="background:${safeColor(m.avatarColor)}">${escapeHtml((m.senderName || '?').charAt(0).toUpperCase())}</div>
      <div class="lchat-body"><div class="lchat-head"><strong></strong><span>${fmtTime(m.ts)}</span></div><div class="lchat-card"></div></div>`;
    row.querySelector('strong').textContent = m.senderName;
    const card = row.querySelector('.lchat-card');
    if (m.kind === 'roll') {
      card.innerHTML = `<div class="roll-line"><span class="roll-emoji">${{ dice: '🎲', coin: '🪙', wheel: '🎡' }[m.type] || '🎲'}</span><span class="roll-text"></span></div>`;
      card.querySelector('.roll-text').textContent = rollText(m);
    } else if (m.kind === 'poll') {
      card.classList.add('poll');
      card.id = 'poll-' + m.pollId;
      renderPoll(card, m);
    } else {
      fillText(card, m.text);
    }
    return row;
  }

  function renderPoll(card, m) {
    card.innerHTML = '<div class="poll-label">📊 Poll</div><div class="poll-q"></div>';
    card.querySelector('.poll-q').textContent = m.question;
    m.options.forEach((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'poll-opt';
      b.innerHTML = '<i class="bar"></i><span class="t"></span><span class="n"></span>';
      b.querySelector('.t').textContent = o.text;
      b.addEventListener('click', () => {
        if (!socket) return;
        socket.emit('poll_vote', { pollId: m.pollId, option: i }, (r) => {
          if (r && !r.success && !r.rate) pv().toast(r.error);
        });
      });
      card.appendChild(b);
    });
    const total = document.createElement('div');
    total.className = 'poll-total';
    card.appendChild(total);
    requestAnimationFrame(() => updatePoll(card, m)); // bars grow in
  }

  function updatePoll(card, m) {
    const me = pv().state.tag;
    const total = m.options.reduce((n, o) => n + o.votes.length, 0);
    const buttons = card.querySelectorAll('.poll-opt');
    if (buttons.length !== m.options.length) return renderPoll(card, m);
    m.options.forEach((o, i) => {
      const p = total ? o.votes.length / total : 0;
      buttons[i].style.setProperty('--p', p.toFixed(3));
      buttons[i].classList.toggle('voted', o.votes.includes(me));
      buttons[i].querySelector('.n').textContent = total ? `${Math.round(p * 100)}% · ${o.votes.length}` : '0';
    });
    card.querySelector('.poll-total').textContent = `${total} vote${total === 1 ? '' : 's'} · click your choice again to remove it`;
  }

  // ---------- reactions + confetti ----------
  function sendReaction(emoji, inCall) {
    const st = pv().state;
    if (!socket) return;
    if (inCall) {
      if (st.inDirectCall && st.directCallPartner) socket.emit('reaction', { emoji, targetCallPeer: st.directCallPartner.id });
    } else if (st.currentLobby) {
      socket.emit('reaction', { emoji });
    }
  }

  function spawnReaction(emoji, by) {
    const layer = $('fun-layer');
    if (layer.childElementCount > 70) return;
    const d = document.createElement('div');
    d.className = 'float-react';
    d.style.left = (6 + Math.random() * 86).toFixed(1) + '%';
    d.style.setProperty('--dx', ((Math.random() - 0.5) * 180).toFixed(0) + 'px');
    d.style.setProperty('--rot', ((Math.random() - 0.5) * 60).toFixed(0) + 'deg');
    d.style.animationDuration = (2.4 + Math.random() * 1.2).toFixed(2) + 's';
    d.textContent = emoji;
    if (by) {
      const s = document.createElement('small');
      s.textContent = by;
      d.appendChild(s);
    }
    d.addEventListener('animationend', () => d.remove());
    layer.appendChild(d);
    if (emoji === '🎉') confetti(window.innerWidth / 2, window.innerHeight * 0.65, 40);
  }

  function confetti(x, y, n) {
    const layer = $('fun-layer');
    for (let i = 0; i < n && layer.childElementCount < 160; i++) {
      const c = document.createElement('i');
      c.className = 'confetti';
      c.style.left = x + 'px';
      c.style.top = y + 'px';
      const angle = Math.random() * Math.PI - Math.PI; // upward fan
      const dist = 140 + Math.random() * 280;
      c.style.setProperty('--tx', (Math.cos(angle) * dist).toFixed(0) + 'px');
      c.style.setProperty('--ty', (Math.sin(angle) * dist).toFixed(0) + 'px');
      c.style.setProperty('--r', ((Math.random() - 0.5) * 900).toFixed(0) + 'deg');
      c.style.setProperty('--c', COLORS[i % COLORS.length]);
      c.style.animationDelay = (Math.random() * 0.12).toFixed(2) + 's';
      c.addEventListener('animationend', () => c.remove());
      layer.appendChild(c);
    }
  }

  // ---------- dice / coin / wheel show ----------
  function buildStage(m) {
    if (m.type === 'dice') {
      const scene = document.createElement('div');
      scene.className = 'dice-scene';
      const cube = document.createElement('div');
      cube.className = 'dice';
      for (let f = 1; f <= 6; f++) {
        const face = document.createElement('div');
        face.className = 'dice-face f' + f;
        for (let p = 0; p < 9; p++) {
          const pip = document.createElement('i');
          if (PIPS[f].includes(p)) pip.className = 'on';
          face.appendChild(pip);
        }
        cube.appendChild(face);
      }
      scene.appendChild(cube);
      const [rx, ry] = DICE_ROT[m.result] || [0, 0];
      requestAnimationFrame(() => requestAnimationFrame(() => {
        cube.style.transform = `rotateX(${rx + 720}deg) rotateY(${ry + 1080}deg)`;
      }));
      return scene;
    }
    if (m.type === 'coin') {
      const scene = document.createElement('div');
      scene.className = 'coin-scene';
      scene.innerHTML = '<div class="coin"><div class="coin-face">HEADS</div><div class="coin-face back">TAILS</div></div>';
      const coin = scene.firstChild;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        coin.style.transform = `rotateY(${1800 + (m.result === 'tails' ? 180 : 0)}deg)`;
      }));
      return scene;
    }
    // wheel
    const names = m.candidates || [];
    const seg = 360 / Math.max(1, names.length);
    const wrap = document.createElement('div');
    wrap.className = 'wheel-wrap';
    wrap.innerHTML = '<div class="wheel-pointer"></div><div class="wheel"></div><div class="wheel-hub"></div>';
    const wheel = wrap.querySelector('.wheel');
    wheel.style.background = `conic-gradient(${names.map((_, i) => `${COLORS[i % COLORS.length]} ${i * seg}deg ${(i + 1) * seg}deg`).join(', ')})`;
    names.forEach((name, i) => {
      const label = document.createElement('span');
      label.className = 'wheel-label';
      label.style.transform = `rotate(${(i + 0.5) * seg - 90}deg)`;
      label.textContent = name;
      wheel.appendChild(label);
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      wheel.style.transform = `rotate(${360 * 6 - (m.result + 0.5) * seg}deg)`;
    }));
    return wrap;
  }

  function showRoll(m) {
    const ov = $('roll-overlay');
    const eng = pv().state.audioEngine;
    clearTimeout(rollTimer);
    ov.innerHTML = '';
    ov.classList.remove('hidden');
    const card = document.createElement('div');
    card.className = 'roll-card';
    const title = document.createElement('div');
    title.className = 'roll-title';
    title.textContent = `${m.senderName} ${m.type === 'dice' ? 'rolls the dice' : m.type === 'coin' ? 'flips a coin' : 'spins the wheel'}…`;
    const result = document.createElement('div');
    result.className = 'roll-result';
    result.textContent = rollText(m);
    card.append(title, buildStage(m), result);
    ov.appendChild(card);
    eng.playPopSound();
    const spin = m.type === 'wheel' ? 3300 : 1700;
    setTimeout(() => {
      result.classList.add('show');
      eng.playTone([523, 659, 784], 'sine', 0.09, 0.07);
      confetti(window.innerWidth / 2, window.innerHeight / 2, m.type === 'wheel' ? 60 : 30);
    }, spin);
    rollTimer = setTimeout(() => {
      card.classList.add('out');
      rollTimer = setTimeout(() => { ov.classList.add('hidden'); ov.innerHTML = ''; }, 400);
    }, spin + 2300);
  }

  // ---------- typing indicators ----------
  function renderTyping(scope) {
    const box = $(scope === 'dm' ? 'dm-typing' : 'lobby-typing');
    const names = Array.from(typers[scope].values(), t => t.name);
    if (!names.length) { box.classList.remove('on'); return; }
    box.innerHTML = '<span class="typing-dots"><i></i><i></i><i></i></span><span></span>';
    box.lastChild.textContent = names.length === 1 ? `${names[0]} is typing…`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
    box.classList.add('on');
  }

  function showTyping(t) {
    const st = pv().state;
    if (t.scope === 'dm' && !(st.selectedFriend && st.selectedFriend.tag === t.tag)) return;
    if (t.scope === 'lobby' && !st.currentLobby) return;
    const map = typers[t.scope];
    if (!map) return;
    const prev = map.get(t.id);
    if (prev) clearTimeout(prev.timer);
    map.set(t.id, { name: t.name, timer: setTimeout(() => { map.delete(t.id); renderTyping(t.scope); }, 3500) });
    renderTyping(t.scope);
  }

  function clearTyping(scope, id) {
    const t = typers[scope].get(id);
    if (!t) return;
    clearTimeout(t.timer);
    typers[scope].delete(id);
    renderTyping(scope);
  }

  function emitTyping(scope) {
    const st = pv().state;
    const now = Date.now();
    if (!socket || now - lastTyping < 1600) return;
    if (scope === 'lobby' && st.currentLobby) socket.emit('typing', { scope: 'lobby' });
    else if (scope === 'dm' && st.selectedFriend && st.selectedFriend.id) socket.emit('typing', { scope: 'dm', target: st.selectedFriend.id });
    else return;
    lastTyping = now;
  }

  // ---------- voice effects ----------
  function syncFx() {
    const cur = pv().state.audioEngine.effect;
    $('select-fx-quick').value = cur;
    document.querySelectorAll('#fx-chips .chip').forEach(c => c.classList.toggle('active', c.dataset.fx === cur));
  }

  function setFx(name) {
    pv().state.audioEngine.setEffect(name);
    syncFx();
    pv().toast(name === 'normal' ? 'Voice effect off' : `Voice effect: ${FX_NAMES[name]}`, 'ok');
  }

  // ---------- polls modal ----------
  function setupPollModal() {
    const modal = $('modal-poll');
    const list = $('poll-options');
    const q = $('input-poll-question');
    const addOpt = () => {
      if (list.children.length >= 6) return null;
      const i = document.createElement('input');
      i.type = 'text';
      i.maxLength = 60;
      i.placeholder = `Option ${list.children.length + 1}`;
      i.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
      list.appendChild(i);
      $('btn-poll-add').classList.toggle('hidden', list.children.length >= 6);
      return i;
    };
    const create = () => {
      if (!socket) return;
      const options = Array.from(list.querySelectorAll('input'), i => i.value.trim()).filter(Boolean);
      socket.emit('poll_create', { question: q.value.trim(), options }, (r) => {
        if (r && r.success) { modal.classList.add('hidden'); return; }
        $('poll-error').textContent = (r && r.error) || 'Could not create the poll.';
        $('poll-error').classList.remove('hidden');
      });
    };
    $('btn-open-poll').addEventListener('click', () => {
      if (!pv().state.currentLobby) return;
      q.value = '';
      list.innerHTML = '';
      addOpt();
      addOpt();
      $('poll-error').classList.add('hidden');
      modal.classList.remove('hidden');
      setTimeout(() => q.focus(), 50);
    });
    $('btn-poll-add').addEventListener('click', () => { const i = addOpt(); if (i) i.focus(); });
    $('btn-poll-create').addEventListener('click', create);
  }

  // ---------- wiring ----------
  function init() {
    document.querySelectorAll('.react-btn').forEach(b => b.addEventListener('click', () => {
      sendReaction(b.dataset.emoji, !!b.closest('[data-target="call"]'));
    }));
    document.querySelectorAll('.fun-btn[data-roll]').forEach(b => b.addEventListener('click', () => {
      if (!socket) return;
      socket.emit('fun_roll', { type: b.dataset.roll }, (r) => {
        if (r && !r.success) pv().toast(r.error);
      });
    }));
    $('select-fx-quick').addEventListener('change', (e) => setFx(e.target.value));
    document.querySelectorAll('#fx-chips .chip').forEach(c => c.addEventListener('click', () => setFx(c.dataset.fx)));
    syncFx();
    setupPollModal();
    pv().el.inputLobbyChat.addEventListener('input', () => { if (pv().el.inputLobbyChat.value) emitTyping('lobby'); });
    pv().el.inputDirectChat.addEventListener('input', () => { if (pv().el.inputDirectChat.value) emitTyping('dm'); });
  }

  // Called by app.js every time a new connection is created (before its own listeners)
  function attach(s) {
    socket = s;
    s.on('reaction', ({ emoji, byName }) => spawnReaction(emoji, byName));
    s.on('lobby_chat', (m) => {
      if (m.kind === 'roll') showRoll(m);
      if (!m.kind || m.kind === 'text') {
        clearTyping('lobby', m.senderId);
        if (mentionsMe(m)) {
          pv().state.audioEngine.playMentionSound();
          if (window.pvQol) window.pvQol.notify(`${m.senderName} mentioned you`, m.text, true);
        }
      }
    });
    s.on('poll_update', ({ pollId, options }) => {
      const msg = pv().state.lobbyChat.find(x => x.pollId === pollId);
      if (!msg) return;
      msg.options = options;
      const card = $('poll-' + pollId);
      if (card) updatePoll(card, msg);
    });
    s.on('typing', showTyping);
    s.on('receive_direct_message', (msg) => {
      clearTyping('dm', msg.senderId);
      if (window.pvQol) window.pvQol.notify(msg.senderName, msg.text, false);
    });
    s.on('incoming_direct_call', ({ caller }) => {
      if (window.pvQol) window.pvQol.notify('Incoming call', `${caller.username} is calling you`, true);
    });
    if (window.pvQol) window.pvQol.attach(s);
  }

  window.pvFun = { attach, renderMsg, fillText, mentionsMe, spawnReaction, confetti };
  init();
})();
