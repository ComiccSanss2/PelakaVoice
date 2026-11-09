// Runs before first paint so the saved theme never flashes. 2.2: "Nova" becomes the default look once.
(function () {
  var themes = ['nova', 'cupertino', 'midnight', 'aurora'];
  var t = null;
  try {
    t = localStorage.getItem('pv_theme');
    if (localStorage.getItem('pv_theme_v') !== '2') {
      t = 'nova';
      localStorage.setItem('pv_theme', t);
      localStorage.setItem('pv_theme_v', '2');
    }
  } catch (e) {}
  document.documentElement.dataset.theme = themes.indexOf(t) >= 0 ? t : 'nova';
})();
