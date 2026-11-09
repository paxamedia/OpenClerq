// The saved theme, applied before the page draws. A file, not an inline
// script, so the content security policy can refuse inline scripts.
(function () {
  try {
    var t = localStorage.getItem('clerq-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) {}
})();
