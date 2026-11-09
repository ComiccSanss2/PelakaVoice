(function () {
  var q = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = q.get('theme') || 'nova';
  document.getElementById('version').textContent = q.get('v') ? 'v' + q.get('v') : '';

  var status = document.getElementById('status');
  var bar = document.getElementById('bar');
  if (!window.electronAPI) return;

  window.electronAPI.onSplashState(function (s) {
    if (s.phase === 'checking') {
      status.textContent = 'Checking for updates…';
    } else if (s.phase === 'downloading') {
      status.textContent = 'Downloading update ' + (s.version || '') + ' — ' + (s.percent || 0) + '%';
      bar.classList.add('fixed');
      bar.style.transform = 'scaleX(' + Math.max(0.02, (s.percent || 0) / 100) + ')';
    } else if (s.phase === 'installing') {
      status.textContent = 'Installing update…';
      bar.classList.remove('fixed');
      bar.style.transform = '';
    } else {
      status.textContent = 'Starting…';
    }
  });
})();
