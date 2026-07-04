(function () {
  var t = localStorage.getItem('mini-term-theme');
  if (t === 'light' || t === 'dark') {
    document.documentElement.dataset.theme = t;
  }
  var bg = t === 'light' ? '#ffffff' : '#0e0d0b';
  document.documentElement.style.background = bg;
  document.body.style.background = bg;
})();
