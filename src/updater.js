// In-app updater (Discord-style): check -> background download -> silent install -> relaunch.
// Built on electron-updater with a "generic" feed that is chosen at runtime.
const { app } = require('electron');

let au = null;
let busy = false;
let state = { phase: 'idle' };
let listener = () => {};

function emit(patch) {
  state = { ...state, ...patch };
  try { listener(state); } catch (e) {}
}

function updater() {
  if (!au) {
    au = require('electron-updater').autoUpdater; // lazy: keeps startup fast
    au.autoDownload = false;
    au.autoInstallOnAppQuit = true; // if the user never clicks "Restart", it installs on next quit
    au.allowDowngrade = false;
    au.logger = null;
    au.on('download-progress', (p) => emit({ phase: 'downloading', percent: Math.round(p.percent || 0) }));
  }
  return au;
}

// Resolves with update info when `url` offers a newer version, otherwise null.
function checkFeed(url, timeoutMs) {
  return new Promise((resolve) => {
    const a = updater();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.removeListener('update-available', onYes);
      a.removeListener('update-not-available', onNo);
      a.removeListener('error', onNo);
      resolve(value);
    };
    const onYes = (info) => finish(info);
    const onNo = () => finish(null);
    const timer = setTimeout(onNo, timeoutMs);
    a.once('update-available', onYes);
    a.once('update-not-available', onNo);
    a.once('error', onNo);
    try {
      a.setFeedURL({ provider: 'generic', url, useMultipleRangeRequest: false });
      Promise.resolve(a.checkForUpdates()).catch(onNo);
    } catch (e) {
      onNo();
    }
  });
}

// feeds: list of base URLs containing latest.yml. install=true installs right away (startup splash).
async function run(feeds, { install = false, timeoutMs = 8000 } = {}) {
  if (!app.isPackaged) { emit({ phase: 'none', dev: true }); return 'none'; }
  if (busy || state.phase === 'ready' || state.phase === 'installing') return state.phase;
  busy = true;
  try {
    emit({ phase: 'checking' });
    for (const feed of [...new Set(feeds.filter(Boolean))]) {
      const info = await checkFeed(feed, timeoutMs);
      if (!info) continue;
      emit({
        phase: 'downloading', percent: 0, version: info.version,
        notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
      });
      await updater().downloadUpdate();
      if (install) {
        emit({ phase: 'installing' });
        setTimeout(() => updater().quitAndInstall(true, true), 900);
        return 'installing';
      }
      emit({ phase: 'ready' });
      return 'ready';
    }
    emit({ phase: 'none' });
    return 'none';
  } catch (err) {
    emit({ phase: 'error', error: String((err && err.message) || err).split('\n')[0] });
    return 'error';
  } finally {
    busy = false;
  }
}

function install() {
  if (state.phase !== 'ready') return false;
  emit({ phase: 'installing' });
  setImmediate(() => updater().quitAndInstall(true, true)); // silent install, then relaunch
  return true;
}

module.exports = {
  run,
  install,
  getState: () => state,
  onState: (fn) => { listener = fn; }
};
