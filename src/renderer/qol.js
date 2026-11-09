// PelakaVoice quality of life: audio settings, mic test, push-to-talk key, hotkeys, notifications,
// remembered per-user volume, lobby search, clipboard invites, pointer effects
(function () {
  const pv = () => window.pv;
  const $ = (id) => document.getElementById(id);
  const api = window.electronAPI || {};
  let testing = false;

  // ---------- desktop notifications (only when the window is in the background) ----------
  function notify(title, body, urgent) {
    if (document.hasFocus() || localStorage.getItem('pv_notif') === '0' || typeof Notification === 'undefined') return;
    try {
      const n = new Notification(title, { body: String(body || '').slice(0, 140), silent: true });
      n.onclick = () => { if (api.focusWindow) api.focusWindow(); n.close(); };
    } catch (e) {}
    if (urgent && api.flash) api.flash();
  }

  // ---------- per-user volume, remembered by tag ----------
  function savedVolume(tag) {
    const v = parseFloat(localStorage.getItem('pv_vol_' + tag));
    return v >= 0 && v <= 2 ? v : null;
  }

  function applyVolume(user) {
    if (!user || !user.tag || !user.id) return;
    const v = savedVolume(user.tag);
    if (v !== null) pv().state.audioEngine.setPeerVolume(user.id, v);
  }

  function findPeer(id) {
    const st = pv().state;
    return st.lobbyPeers.get(id) || (st.directCallPartner && st.directCallPartner.id === id ? st.directCallPartner : null);
  }

  function setupVolumeMemory() {
    const st = pv().state;
    const el = pv().el;
    const save = () => {
      const peer = findPeer(st.activeContextPeerId);
      if (peer && peer.tag) localStorage.setItem('pv_vol_' + peer.tag, String(parseInt(el.contextVolumeSlider.value, 10) / 100));
    };
    el.contextVolumeSlider.addEventListener('input', save);
    el.btnContextMutePeer.addEventListener('click', save);
    el.btnContextResetPeer.addEventListener('click', save);
  }

  // ---------- audio settings ----------
  function reopenMic() {
    const st = pv().state;
    const eng = st.audioEngine;
    const inCall = st.currentLobby || st.inDirectCall;
    if (!inCall && !testing) return;
    eng.initLocalMicrophone(st.selectedMicDevice).then((stream) => {
      if (inCall && st.webrtc) st.webrtc.setLocalStream(stream);
    }).catch((e) => pv().toast('Microphone error: ' + e.message));
  }

  function setupAudioSettings() {
    const eng = pv().state.audioEngine;
    const out = $('select-out-device');

    async function fillOutputs() {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const outs = devs.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
        out.innerHTML = '<option value="">Default system output</option>';
        outs.forEach((d, i) => {
          const o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || `Output ${i + 1}`;
          out.appendChild(o);
        });
        out.value = outs.some(d => d.deviceId === eng.sinkId) ? eng.sinkId : '';
      } catch (e) {}
    }
    fillOutputs();
    navigator.mediaDevices.addEventListener('devicechange', () => {
      fillOutputs();
      if (pv().refreshDevices) pv().refreshDevices();
    });
    out.addEventListener('change', async () => {
      await eng.setOutputDevice(out.value);
      eng.playJoinSound();
    });

    const ns = $('check-ns');
    const ec = $('check-ec');
    ns.checked = eng.noiseSuppression;
    ec.checked = eng.echoCancellation;
    ns.addEventListener('change', () => { eng.setProcessing({ noiseSuppression: ns.checked }); reopenMic(); });
    ec.addEventListener('change', () => { eng.setProcessing({ echoCancellation: ec.checked }); reopenMic(); });

    // Mic test: opens the mic (if not in a call) and plays it back with the current voice effect
    const btn = $('btn-mic-test');
    const stopTest = () => {
      if (!testing) return;
      testing = false;
      eng.setMonitor(false);
      const st = pv().state;
      if (!st.currentLobby && !st.inDirectCall) eng.stopLocalStream();
      btn.textContent = 'Test microphone';
      btn.classList.remove('active');
    };
    btn.addEventListener('click', async () => {
      if (testing) return stopTest();
      try {
        if (!eng.hasMic()) await eng.initLocalMicrophone(pv().state.selectedMicDevice);
        eng.setMonitor(true);
        testing = true;
        btn.textContent = 'Stop test';
        btn.classList.add('active');
        pv().toast('You should hear yourself now — use headphones to avoid echo.', 'ok');
      } catch (e) {
        pv().toast('Microphone error: ' + e.message);
      }
    });
    document.querySelectorAll('.segment-btn').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.tab !== 'tab-settings') stopTest();
    }));
  }

  // ---------- push-to-talk key ----------
  function keyName(code) {
    return String(code || 'Space').replace(/^Key/, '').replace(/^Digit/, '').replace(/^(Shift|Control|Alt)(Left|Right)$/, '$1 $2')
      .replace(/^Mouse/, 'Mouse ');
  }

  function setupPttKey() {
    const btn = $('btn-ptt-key');
    const show = () => {
      const k = keyName(pv().state.pttKey);
      btn.textContent = k;
      $('ptt-key-label').textContent = k;
    };
    show();
    let listening = false;
    btn.addEventListener('click', () => {
      listening = true;
      btn.textContent = 'Press a key…';
      btn.classList.add('listening');
      btn.blur();
    });
    window.addEventListener('keydown', (e) => {
      if (!listening) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      listening = false;
      btn.classList.remove('listening');
      if (e.code !== 'Escape' && e.code) {
        pv().state.pttKey = e.code;
        localStorage.setItem('pv_ptt', e.code);
      }
      show();
    }, true);
  }

  // ---------- keyboard: global hotkeys, D to deafen, Esc to close ----------
  function setupKeys() {
    if (api.onHotkey) {
      api.onHotkey((action) => {
        if (action === 'mute') pv().toggleMute();
        else if (action === 'deafen') pv().toggleDeafen();
      });
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const open = Array.from(document.querySelectorAll('.modal-backdrop:not(.hidden)')).filter(m => m.id !== 'modal-incoming-call');
        if (open.length) open[open.length - 1].classList.add('hidden');
        else pv().el.participantContextMenu.classList.add('hidden');
        return;
      }
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (e.code === 'KeyD' && pv().state.pttKey !== 'KeyD' && pv().el.appScreen.classList.contains('active')) pv().toggleDeafen();
    });
  }

  // ---------- notifications + autostart toggles ----------
  function setupToggles() {
    const notif = $('check-notifications');
    notif.checked = localStorage.getItem('pv_notif') !== '0';
    notif.addEventListener('change', () => localStorage.setItem('pv_notif', notif.checked ? '1' : '0'));

    const auto = $('check-autostart');
    if (!api.getAutostart) { $('autostart-row').classList.add('hidden'); return; }
    api.getAutostart().then(v => { auto.checked = !!v; });
    auto.addEventListener('change', async () => { auto.checked = await api.setAutostart(auto.checked); });
  }

  // ---------- lobby search ----------
  function setupSearch() {
    const input = $('input-lobby-search');
    const grid = pv().el.lobbiesGrid;
    const apply = () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      const cards = grid.querySelectorAll('.lobby-card');
      cards.forEach(c => {
        const ok = !q || c.textContent.toLowerCase().includes(q);
        c.classList.toggle('hidden', !ok);
        if (ok) shown++;
      });
      let none = grid.querySelector('.search-empty');
      if (q && cards.length && !shown) {
        if (!none) { none = document.createElement('div'); none.className = 'search-empty'; grid.appendChild(none); }
        none.textContent = `No lobby matches “${input.value.trim()}”`;
      } else if (none) {
        none.remove();
      }
    };
    input.addEventListener('input', apply);
    new MutationObserver(() => { if (input.value) apply(); }).observe(grid, { childList: true });
  }

  // ---------- invite code waiting in the clipboard ----------
  async function checkClipboard() {
    const chip = $('clip-invite');
    if (!api.readClipboard || !$('login-screen').classList.contains('active')) return;
    let text = '';
    try { text = String(await api.readClipboard() || '').trim(); } catch (e) { return; }
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i) || text.match(/^[a-z0-9]+(?:-[a-z0-9]+){2,6}$/i);
    if (!m) { chip.classList.add('hidden'); return; }
    const val = m[0];
    const code = val.replace(/^https:\/\//i, '').replace(/\.trycloudflare\.com$/i, '').toLowerCase();
    if ($('input-server-url').value.toLowerCase().includes(code)) { chip.classList.add('hidden'); return; }
    chip.textContent = `Use invite from clipboard: ${code}`;
    chip.onclick = () => {
      $('input-server-url').value = code;
      chip.classList.add('hidden');
      $('input-nickname').focus();
    };
    chip.classList.remove('hidden');
  }

  // ---------- small UI niceties ----------
  function setupUi() {
    // Click your tag to copy it
    $('my-tag-text').title = 'Click to copy';
    $('my-tag-text').addEventListener('click', () => {
      const tag = pv().state.tag;
      if (tag) navigator.clipboard.writeText(tag).then(() => pv().toast('Your tag was copied', 'ok')).catch(() => {});
    });

    // New people pop into the participants grid (others don't re-animate)
    const grid = pv().el.participantsGrid;
    const seen = new Set();
    new MutationObserver(() => {
      const cards = grid.querySelectorAll('.participant-card');
      const ids = new Set();
      cards.forEach(c => {
        ids.add(c.id);
        if (!seen.has(c.id)) { seen.add(c.id); c.classList.add('enter'); }
      });
      seen.forEach(id => { if (!ids.has(id)) seen.delete(id); });
    }).observe(grid, { childList: true });

    // Spotlight that follows the cursor on cards + 3D tilt of the login card (one rAF per frame max)
    const SPOT = '.lobby-card, .participant-card, .sound-btn, .settings-block, .lobby-chat, .friends-sidebar, .friends-main-deck';
    let raf = 0;
    let last = null;
    document.addEventListener('pointermove', (e) => {
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const t = last.target && last.target.closest ? last.target.closest(SPOT) : null;
        if (t) {
          const r = t.getBoundingClientRect();
          t.style.setProperty('--mx', (last.clientX - r.left).toFixed(0) + 'px');
          t.style.setProperty('--my', (last.clientY - r.top).toFixed(0) + 'px');
        }
        const card = document.querySelector('#login-screen.active .login-modal-card');
        if (card) {
          const dx = last.clientX / window.innerWidth - 0.5;
          const dy = last.clientY / window.innerHeight - 0.5;
          card.style.setProperty('--ry', (dx * 9).toFixed(2) + 'deg');
          card.style.setProperty('--rx', (-dy * 9).toFixed(2) + 'deg');
        }
      });
    }, { passive: true });

    // Material-style ripple on buttons
    const RIPPLE = '.btn-primary, .btn-primary-large, .btn-primary-sm, .btn-ghost, .btn-danger, .btn-ghost-danger, .dock-action-btn, .fun-btn, .btn-join-lobby, .chip, .q-btn, .btn-send';
    document.addEventListener('pointerdown', (e) => {
      const b = e.target.closest ? e.target.closest(RIPPLE) : null;
      if (!b || b.disabled) return;
      const r = b.getBoundingClientRect();
      const size = Math.max(r.width, r.height) * 2.2;
      const s = document.createElement('span');
      s.className = 'rp';
      s.style.width = s.style.height = size + 'px';
      s.style.left = (e.clientX - r.left - size / 2) + 'px';
      s.style.top = (e.clientY - r.top - size / 2) + 'px';
      s.addEventListener('animationend', () => s.remove());
      b.appendChild(s);
    });
  }

  // Called for every new connection (from fun.js)
  function attach(socket) {
    const st = pv().state;
    if (st.webrtc) st.webrtc.onPeerStreamAdded = (peerId) => applyVolume(findPeer(peerId));
    socket.on('lobby_user_joined', ({ user }) => applyVolume(user));
  }

  window.pvQol = { attach, notify, applyVolume };

  setupVolumeMemory();
  setupAudioSettings();
  setupPttKey();
  setupKeys();
  setupToggles();
  setupSearch();
  setupUi();
  window.addEventListener('focus', checkClipboard);
  checkClipboard();
})();
