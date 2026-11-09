// PelakaVoice hosting from inside the app (no .bat needed) + recent servers on the login screen
(function () {
  const pv = () => window.pv;
  const $ = (id) => document.getElementById(id);
  const api = window.electronAPI || {};
  const host = { running: false, port: 0, online: false, code: '', phase: '' };

  function codeOf(url) {
    const m = /^https:\/\/([a-z0-9-]+)\.trycloudflare\.com/i.exec(url || '');
    return m ? m[1] : '';
  }

  function render() {
    const s = host;
    let text = 'Not hosting';
    if (s.running) {
      if (s.code) text = 'Online worldwide — friends join with your invite code';
      else if (s.phase === 'preparing') text = `Preparing the secure tunnel… ${s.percent || 0}%`;
      else if (s.phase === 'connecting') text = s.reconnecting ? 'Connection dropped — reconnecting (the code will change)…' : 'Connecting to the Cloudflare network…';
      else if (s.phase === 'error' || (s.phase === 'stopped' && s.error)) text = `LAN only — online tunnel unavailable (${s.error || 'unknown error'})`;
      else text = `Running on your network (port ${s.port})`;
    }
    $('srv-status-text').textContent = text;
    $('srv-dot').className = 'status-dot' + (s.running ? (s.code ? ' pulse' : '') : ' off');
    $('srv-invite').classList.toggle('hidden', !s.code);
    $('srv-invite-code').textContent = s.code;
    $('btn-srv-online').classList.toggle('hidden', s.running && s.online);
    $('btn-srv-lan').classList.toggle('hidden', s.running);
    $('btn-srv-stop').classList.toggle('hidden', !s.running);
    $('btn-srv-join').classList.toggle('hidden', !s.running || isOnMyServer());

    // top bar pill + card in the lobby list
    $('nav-host-pill').classList.toggle('hidden', !s.running);
    $('nav-host-text').textContent = s.code ? `Hosting · ${s.code.split('-').slice(0, 2).join('-')}…` : 'Hosting (LAN)';
    $('rail-server').classList.toggle('hidden', !s.code);
    $('rs-code').textContent = s.code;
  }

  function isOnMyServer() {
    const url = pv().state.serverUrl || '';
    return pv().el.appScreen.classList.contains('active') &&
      (url === `http://127.0.0.1:${host.port}` || (host.code && url.includes(host.code)));
  }

  function copyCode() {
    if (!host.code) return;
    navigator.clipboard.writeText(host.code).then(() => pv().toast('Invite code copied — send it to your friends', 'ok')).catch(() => {});
  }

  function onState(s) {
    if (s.phase === 'local') {
      host.running = true;
      host.port = s.port;
      if ($('login-screen').classList.contains('active')) pv().el.inputServerUrl.value = `http://127.0.0.1:${s.port}`;
    }
    if (s.phase === 'online') { host.code = s.code || codeOf(s.url); host.online = true; }
    if (s.phase === 'connecting' || s.phase === 'preparing') { host.online = true; host.code = ''; }
    if (s.phase === 'stopped' && !s.error) { host.running = false; host.online = false; host.code = ''; }
    if (s.phase === 'stopped' && s.error) { host.code = ''; host.online = false; }
    host.phase = s.phase;
    host.percent = s.percent;
    host.error = s.error;
    host.reconnecting = !!s.reconnecting;
    render();
  }

  async function start(online) {
    const res = await api.hostStart(online);
    if (!res || !res.success) { pv().toast('Server error: ' + (res ? res.error : 'unknown')); return; }
    host.running = true;
    host.port = res.port;
    if (online) host.online = true;
    render();
  }

  function joinMine() {
    const el = pv().el;
    const go = () => {
      el.inputServerUrl.value = `http://127.0.0.1:${host.port}`;
      if (el.inputNickname.value.trim()) el.btnLoginSubmit.click();
      else { el.inputNickname.focus(); pv().toast('Enter your nickname, then press Join'); }
    };
    if (el.appScreen.classList.contains('active')) { el.btnLabLogout.click(); setTimeout(go, 200); } else go();
  }

  // ---------- recent servers (one click to rejoin) ----------
  function recent() {
    try { return JSON.parse(localStorage.getItem('pv_recent') || '[]').filter(r => r && r.url); } catch (e) { return []; }
  }

  function remember(url) {
    if (!url || /^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) { renderRecent(); return; }
    const list = recent().filter(r => r.url !== url);
    list.unshift({ url, ts: Date.now() });
    localStorage.setItem('pv_recent', JSON.stringify(list.slice(0, 4)));
    renderRecent();
  }

  function renderRecent() {
    const box = $('recent-servers');
    const list = recent();
    box.innerHTML = '';
    if (!list.length) return;
    const label = document.createElement('span');
    label.className = 'recent-label';
    label.textContent = 'Recent:';
    box.appendChild(label);
    list.forEach(r => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'recent-chip';
      const code = codeOf(r.url);
      b.textContent = code ? code.split('-').slice(0, 3).join('-') : r.url.replace(/^https?:\/\//, '');
      b.title = r.url;
      b.addEventListener('click', () => {
        pv().el.inputServerUrl.value = r.url;
        if (pv().el.inputNickname.value.trim()) pv().el.btnLoginSubmit.click();
      });
      box.appendChild(b);
    });
  }

  function init() {
    if (!api.hostStart) {
      $('settings-server').classList.add('hidden');
      renderRecent();
      return;
    }
    $('btn-srv-online').addEventListener('click', () => start(true));
    $('btn-srv-lan').addEventListener('click', () => start(false));
    $('btn-srv-stop').addEventListener('click', async () => {
      await api.hostStop();
      onState({ phase: 'stopped' });
    });
    $('btn-srv-join').addEventListener('click', joinMine);
    $('btn-srv-copy').addEventListener('click', copyCode);
    $('nav-host-pill').addEventListener('click', copyCode);
    $('rail-server').addEventListener('click', copyCode);

    const auto = $('select-autohost');
    const tray = $('check-tray');
    auto.addEventListener('change', () => api.hostConfig({ autoHost: auto.value }));
    tray.addEventListener('change', () => api.hostConfig({ tray: tray.checked }));

    api.onHostState(onState);
    api.hostStatus().then((s) => {
      auto.value = s.autoHost || '';
      tray.checked = s.tray !== false;
      host.running = s.running;
      host.port = s.port;
      host.online = s.online;
      host.code = s.code || '';
      if (s.last) host.phase = s.last.phase;
      render();
      // hosting was started automatically: offer a one-click join on the login screen
      if (s.running && $('login-screen').classList.contains('active')) pv().el.inputServerUrl.value = `http://127.0.0.1:${s.port}`;
    });
    renderRecent();
  }

  window.pvHost = { remember };
  init();
})();
