// A stand-in module UI for the preview: it shows the bridge working.
window.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.type === 'clerq:token') document.getElementById('status').textContent = 'Signed in with a module token.';
  if (d.type === 'clerq:theme') document.documentElement.dataset.theme = d.theme;
});
parent.postMessage({ type: 'clerq:height', height: document.body.scrollHeight + 16 }, '*');
