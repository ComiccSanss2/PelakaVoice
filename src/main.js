const { app, BrowserWindow, ipcMain, session, desktopCapturer, globalShortcut, shell, clipboard, screen, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  boot();
}

function boot() {
  const pkg = require('../package.json');
  const updater = require('./updater');
  const DEBUG = !!process.env.PELAKA_DEBUG;
  const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
  const PRELOAD = path.join(__dirname, 'preload.js');
  const THEMES = {
    nova: { bg: '#07070d', fg: '#f4f4ff' },
    cupertino: { bg: '#f5f5f7', fg: '#1d1d1f' },
    midnight: { bg: '#000000', fg: '#f5f5f7' },
    aurora: { bg: '#0d0b1a', fg: '#ece9ff' }
  };

  let mainWindow = null;
  let splash = null;
  let cfg = {};
  const host = { server: null, port: 0, tunnel: null, url: null, online: false, last: null, retries: 0 };
  const presence = { inCall: false };
  let tray = null;
  let quitting = false;
  let trayHintShown = false;
  let pendingCapture = null;

  // ---------- tiny persisted config (theme + last server, used before the UI exists) ----------
  const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
  const loadCfg = () => { try { cfg = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) || {}; } catch (e) { cfg = {}; } };
  const saveCfg = () => { fs.writeFile(cfgFile(), JSON.stringify(cfg), () => {}); };
  const theme = () => THEMES[cfg.theme] || THEMES.nova;
  const send = (channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  };

  // Update feeds: optional fixed URL from package.json first, then the last server we joined
  // Update feeds: fixed URL (package.json) + every recent server + this PC's own server when hosting
  const feeds = (server) => {
    const list = [];
    const fixed = pkg.pelaka && pkg.pelaka.updateUrl;
    if (fixed) list.push(String(fixed).replace(/\/+$/, ''));
    const servers = server ? [server] : [cfg.lastServer].concat(cfg.recentServers || []);
    servers.filter(Boolean).forEach(x => list.push(String(x).replace(/\/+$/, '') + '/updates'));
    if (host.server) list.push(`http://127.0.0.1:${host.port}/updates`);
    return Array.from(new Set(list));
  };

  const newer = (a, b) => require('../server/server').compareVersions(a, b) > 0;

  // Ask every feed in parallel (2.5 s max) and keep only those offering a newer version, newest first.
  // Dead addresses (old tunnels) cost nothing this way.
  async function aliveFeeds(list) {
    const results = await Promise.all(list.map(async (f) => {
      try {
        const res = await fetch(f + '/latest.yml', { signal: AbortSignal.timeout(2500), cache: 'no-store' });
        if (!res.ok) return null;
        const m = /^version:\s*['"]?([\d.]+)/m.exec(await res.text());
        return m && newer(m[1], app.getVersion()) ? { f, v: m[1] } : null;
      } catch (e) {
        return null;
      }
    }));
    return results.filter(Boolean).sort((a, b) => (newer(a.v, b.v) ? -1 : 1)).map(r => r.f);
  }

  // If you publish updates on this PC (PUBLISH-UPDATE.bat) your own app finds them at startup too
  async function serveLocalUpdates() {
    const dir = path.join(app.getPath('userData'), 'updates');
    if (!fs.existsSync(path.join(dir, 'latest.yml'))) return null;
    try {
      const s = require('../server/server').createSignalingServer(0, { updatesDir: dir });
      await s.start();
      return { url: `http://127.0.0.1:${s.server.address().port}/updates`, close: () => s.stop().catch(() => {}) };
    } catch (e) {
      return null;
    }
  }

  const checkAll = async (opts) => updater.run(await aliveFeeds(feeds()), opts);

  // ---------- windows ----------
  function createSplash() {
    splash = new BrowserWindow({
      width: 300, height: 340, frame: false, resizable: false, maximizable: false, show: false,
      backgroundColor: theme().bg, icon: ICON, title: 'PelakaVoice',
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, spellcheck: false }
    });
    splash.loadFile(path.join(__dirname, 'renderer', 'splash.html'), {
      query: { theme: THEMES[cfg.theme] ? cfg.theme : 'nova', v: app.getVersion() }
    });
    splash.once('ready-to-show', () => splash && splash.show());
    splash.on('closed', () => { splash = null; });
  }

  // Restore the last window size/position if it still fits on a connected screen
  function savedBounds() {
    const b = cfg.bounds;
    if (!b || !(b.width >= 940 && b.height >= 620)) return { width: 1180, height: 780 };
    const area = screen.getDisplayMatching(b).workArea;
    const visible = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100 && b.y >= area.y - 10 && b.y < area.y + area.height - 100;
    return visible ? b : { width: b.width, height: b.height };
  }

  // ---------- tray: keeps the server / call alive when the window is closed ----------
  function showMain() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function refreshTray() {
    if (!tray) return;
    const code = host.url ? require('../server/tunnel').inviteCode(host.url) : '';
    tray.setToolTip(host.server ? `PelakaVoice — hosting${code ? ': ' + code : ' (LAN)'}` : 'PelakaVoice');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open PelakaVoice', click: showMain },
      { label: code ? `Copy invite code (${code})` : 'Copy invite code', enabled: !!code, click: () => clipboard.writeText(code) },
      { type: 'separator' },
      { label: 'Stop hosting', enabled: !!host.server, click: () => { stopHosting().then(() => send('host-state', { phase: 'stopped' })); } },
      { label: 'Quit PelakaVoice', click: () => { quitting = true; app.quit(); } }
    ]));
  }

  function ensureTray() {
    if (tray) return;
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.on('click', showMain);
    refreshTray();
  }

  function createMain(onReady) {
    mainWindow = new BrowserWindow({
      ...savedBounds(), minWidth: 940, minHeight: 620, show: false,
      backgroundColor: theme().bg, title: 'PelakaVoice', icon: ICON, autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: theme().bg, symbolColor: theme().fg, height: 44 },
      webPreferences: {
        preload: PRELOAD, nodeIntegration: false, contextIsolation: true, sandbox: true,
        spellcheck: false, autoplayPolicy: 'no-user-gesture-required'
      }
    });
    mainWindow.removeMenu();
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWindow.once('ready-to-show', onReady);
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.on('close', (e) => {
      if (quitting || cfg.tray === false || !(host.server || presence.inCall)) return;
      e.preventDefault(); // keep hosting / talking in the background
      ensureTray();
      mainWindow.hide();
      if (!trayHintShown && Notification.isSupported()) {
        trayHintShown = true;
        new Notification({
          title: 'PelakaVoice is still running',
          body: host.server ? 'Your server stays online. Right-click the tray icon to quit.' : 'You are still in the call. Right-click the tray icon to quit.',
          silent: true
        }).show();
      }
    });
    mainWindow.on('focus', () => { if (mainWindow) mainWindow.flashFrame(false); });
    if (cfg.maximized) mainWindow.maximize();
    let boundsTimer = null;
    const remember = () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
        cfg.maximized = mainWindow.isMaximized();
        if (!cfg.maximized) cfg.bounds = mainWindow.getBounds();
        saveCfg();
      }, 500);
    };
    mainWindow.on('resize', remember);
    mainWindow.on('move', remember);
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

    if (DEBUG) {
      mainWindow.webContents.on('console-message', (...a) => {
        const d = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2], lineNumber: a[3], sourceId: a[4] };
        console.log(`[renderer:${d.level}] ${d.message} (${path.basename(String(d.sourceId || ''))}:${d.lineNumber})`);
      });
      mainWindow.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', p, err));
    }
  }

  // ---------- hosting: local server + optional Cloudflare tunnel ----------
  function report(s) {
    host.last = s;
    send('host-state', s);
    refreshTray();
  }

  async function openTunnel() {
    try {
      const tunnel = require('../server/tunnel');
      report({ phase: 'preparing', percent: 0 });
      const bin = await tunnel.ensureCloudflared(
        [path.join(__dirname, '..', 'server'), path.join(app.getPath('userData'), 'bin')],
        (percent) => report({ phase: 'preparing', percent })
      );
      if (!host.server) return;
      report({ phase: 'connecting' });
      host.tunnel = tunnel.startTunnel(bin, host.port, {
        onUrl: (url) => { host.url = url; host.retries = 0; report({ phase: 'online', url, code: tunnel.inviteCode(url) }); },
        onExit: (error) => {
          host.tunnel = null;
          host.url = null;
          if (host.server && host.online && host.retries++ < 5) { // the tunnel dropped: reconnect (new invite code)
            report({ phase: 'connecting', reconnecting: true });
            setTimeout(() => { if (host.server && host.online && !host.tunnel) openTunnel(); }, 3000);
          } else {
            report({ phase: 'stopped', error: error || 'The tunnel was closed.' });
          }
        }
      });
    } catch (err) {
      report({ phase: 'error', error: err.message });
    }
  }

  async function startHosting(online) {
    try {
      const { createSignalingServer, getLocalIpAddresses } = require('../server/server');
      if (!host.server) {
        let lastErr = null;
        const updatesDir = path.join(app.getPath('userData'), 'updates'); // the in-app server also distributes updates
        for (let port = 3000; port < 3010 && !host.server; port++) {
          const s = createSignalingServer(port, { updatesDir });
          try {
            await s.start();
            host.server = s;
            host.port = port;
          } catch (err) {
            lastErr = err;
            s.stop().catch(() => {});
            if (err.code !== 'EADDRINUSE') break;
          }
        }
        if (!host.server) throw lastErr || new Error('Could not start the server');
        report({ phase: 'local', port: host.port, ips: getLocalIpAddresses() });
      }
      if (online) {
        host.online = true;
        host.retries = 0;
        if (!host.tunnel) openTunnel();
      }
      return { success: true, port: host.port, ips: getLocalIpAddresses() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function stopHosting() {
    host.online = false;
    if (host.tunnel) { host.tunnel.stop(); host.tunnel = null; }
    host.url = null;
    if (host.server) {
      const s = host.server;
      host.server = null;
      try { await s.stop(); } catch (e) {}
    }
  }

  function registerIpc() {
    ipcMain.handle('get-app-version', () => app.getVersion());

    ipcMain.handle('get-screen-sources', async () => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }
        });
        return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
      } catch (err) {
        return [];
      }
    });

    ipcMain.handle('host-start', (_e, online) => startHosting(online));
    ipcMain.handle('host-status', () => ({
      running: !!host.server, port: host.port, online: host.online, url: host.url,
      code: host.url ? require('../server/tunnel').inviteCode(host.url) : '', last: host.last,
      autoHost: cfg.autoHost || '', tray: cfg.tray !== false
    }));
    ipcMain.handle('host-config', (_e, conf) => {
      if (conf && 'autoHost' in conf) cfg.autoHost = ['online', 'lan'].includes(conf.autoHost) ? conf.autoHost : '';
      if (conf && 'tray' in conf) cfg.tray = !!conf.tray;
      saveCfg();
      return { autoHost: cfg.autoHost || '', tray: cfg.tray !== false };
    });
    ipcMain.on('presence', (_e, p) => { presence.inCall = !!(p && p.inCall); refreshTray(); });

    // Stream capture: the renderer picks a source, then calls getDisplayMedia().
    // 'loopbackWithoutChrome' = system audio WITHOUT PelakaVoice's own output, so the voices of the call
    // never end up inside the stream.
    ipcMain.handle('capture-select', (_e, sel) => { pendingCapture = sel && sel.id ? { id: String(sel.id), audio: !!sel.audio } : null; return true; });
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
      const sel = pendingCapture;
      pendingCapture = null;
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        const src = (sel && sources.find(x => x.id === sel.id)) || sources.find(x => x.id.startsWith('screen'));
        if (!src) return cb({});
        cb(sel && sel.audio && process.platform === 'win32' ? { video: src, audio: 'loopbackWithoutChrome' } : { video: src });
      } catch (e) {
        cb({});
      }
    });

    // MSN-style nudge: shake the window
    ipcMain.on('shake-window', () => {
      if (!mainWindow || mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
      if (!mainWindow.isVisible()) mainWindow.showInactive();
      const [x, y] = mainWindow.getPosition();
      const steps = [[-9, 0], [9, 3], [-7, -3], [7, 2], [-5, 0], [5, -2], [-2, 1], [0, 0]];
      steps.forEach(([dx, dy], i) => setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setPosition(x + dx, y + dy);
      }, i * 45));
    });

    ipcMain.handle('host-stop', async () => { await stopHosting(); return { success: true }; });

    ipcMain.on('set-theme', (_e, name) => {
      if (!THEMES[name]) return;
      cfg.theme = name;
      saveCfg();
      if (mainWindow && mainWindow.setTitleBarOverlay) {
        try { mainWindow.setTitleBarOverlay({ color: THEMES[name].bg, symbolColor: THEMES[name].fg, height: 44 }); } catch (e) {}
        mainWindow.setBackgroundColor(THEMES[name].bg);
      }
    });

    // Called after a successful login: remember the server and look for updates there
    ipcMain.on('set-server', (_e, url) => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url + '/')) {
        cfg.lastServer = url;
        cfg.recentServers = [url].concat((cfg.recentServers || []).filter(u => u !== url)).slice(0, 6);
        saveCfg();
      }
      updater.run(feeds(url));
    });

    ipcMain.on('open-external', (_e, url) => {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
    });
    ipcMain.on('focus-window', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    ipcMain.handle('read-clipboard', async () => String((await clipboard.readText()) || '').slice(0, 300));
    ipcMain.handle('get-autostart', () => app.getLoginItemSettings().openAtLogin);
    ipcMain.handle('set-autostart', (_e, on) => {
      app.setLoginItemSettings({ openAtLogin: !!on });
      return app.getLoginItemSettings().openAtLogin;
    });

    // Blink the taskbar button when a DM arrives while the window is in the background
    ipcMain.on('flash', () => { if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true); });

    ipcMain.handle('update-check', () => checkAll());
    // "What's new" popup right after an update was installed
    ipcMain.handle('whats-new', () => {
      const n = cfg.updNotes;
      if (!n || n.version !== app.getVersion()) return null;
      cfg.updNotes = null;
      saveCfg();
      return n;
    });
    ipcMain.handle('update-install', () => updater.install());
    ipcMain.handle('update-state', () => updater.getState());
  }

  // ---------- app lifecycle ----------
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isVisible()) { showMain(); return; }
    const w = mainWindow || splash;
    if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
  });

  app.whenReady().then(async () => {
    loadCfg();
    if (process.platform === 'win32') app.setAppUserModelId('com.pelakavoice.app');
    if (cfg.themeV !== 2) { cfg.theme = 'nova'; cfg.themeV = 2; saveCfg(); } // 2.2: Nova becomes the default look

    // Global hotkeys: work even while a game has the focus
    const hotkey = (accel, action) => {
      try { globalShortcut.register(accel, () => send('hotkey', action)); } catch (e) {}
    };
    hotkey('CommandOrControl+Shift+M', 'mute');
    hotkey('CommandOrControl+Shift+D', 'deafen');

    const ALLOWED = ['media', 'display-capture', 'fullscreen', 'notifications', 'clipboard-sanitized-write', 'speaker-selection'];
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.includes(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED.includes(permission));

    registerIpc();
    createSplash();

    // Load the main UI hidden while the splash checks for updates
    let mainReady = false;
    let updateDone = false;
    const reveal = () => {
      if (!mainReady || !updateDone || !mainWindow) return;
      mainWindow.show();
      if (splash) splash.destroy();
    };
    createMain(() => { mainReady = true; reveal(); });

    updater.onState((s) => {
      if (splash && !splash.isDestroyed()) splash.webContents.send('splash-state', s);
      send('update-state', s);
      if (s.phase === 'downloading' && s.version && (!cfg.updNotes || cfg.updNotes.version !== s.version)) {
        cfg.updNotes = { version: s.version, notes: s.notes || '' };
        saveCfg();
      }
    });

    const local = await serveLocalUpdates();
    const startFeeds = await aliveFeeds((local ? [local.url] : []).concat(feeds()));
    const result = await updater.run(startFeeds, { install: true, timeoutMs: 6000 });
    if (local) setTimeout(local.close, result === 'installing' ? 30000 : 0);
    if (result === 'installing') {
      if (mainWindow) mainWindow.destroy();
      return; // the updater quits, installs silently and relaunches the app
    }
    updateDone = true;
    if (cfg.autoHost) {
      startHosting(cfg.autoHost === 'online');
      ensureTray();
    }
    reveal();

    // Long sessions: look again every 3 hours
    const again = setInterval(() => checkAll(), 3 * 60 * 60 * 1000);
    if (again.unref) again.unref();

    if (process.env.PELAKA_SMOKE) setTimeout(() => app.quit(), 7000);
  });

  app.on('before-quit', () => { quitting = true; if (host.tunnel) host.tunnel.stop(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', async () => {
    await stopHosting();
    app.quit();
  });
}
