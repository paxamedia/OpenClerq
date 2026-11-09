// The desktop hosts this page in an iframe and posts it a module token
// (POST /modules/hello-world/token). The page sends it on its own API calls.
window.addEventListener('message', async (event) => {
  const token = event.data && event.data.type === 'clerq:token' ? event.data.token : null;
  if (!token) return;
  const res = await fetch('../greetings', { headers: { Authorization: `Bearer ${token}` } });
  const { greetings } = await res.json();
  document.getElementById('greetings').textContent =
    greetings.length === 0 ? 'Nobody greeted yet.' : greetings.map((g) => g.name).join(', ');
});
