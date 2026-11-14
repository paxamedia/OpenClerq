// The desktop hosts this page in an iframe and posts it a token
// (POST /modules/hello-plugin/token). The token reaches this plugin's own routes and the
// core endpoints its manifest lists under permissions.api, and nothing else.
window.addEventListener('message', async (event) => {
  const token = event.data && event.data.type === 'clerq:token' ? event.data.token : null;
  if (!token) return;
  const res = await fetch('../hello', { headers: { Authorization: `Bearer ${token}` } });
  const { message } = await res.json();
  document.getElementById('hello').textContent = message;
});
