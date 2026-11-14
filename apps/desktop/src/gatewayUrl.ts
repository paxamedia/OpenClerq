/**
 * The address the desktop app uses for its gateway.
 *
 * The app runs under a Content-Security-Policy (src-tauri/tauri.conf.json) that lets it connect
 * to and frame `127.0.0.1` and nothing else, not `localhost`. A "Gateway URL" saved before that,
 * as `http://localhost:18790`, would have every call blocked with no message, so `localhost` is
 * used as `127.0.0.1` (the same computer: the gateway listens on 127.0.0.1). The saved setting
 * is left as it is. Any other host is blocked by the policy and is not changed here; Settings
 * says so when it is typed.
 */
export function desktopGatewayUrl(url: string): string {
  return url.replace(/^(\s*[a-z][a-z0-9+.-]*:\/\/)localhost(?=[:/?#]|\s*$)/i, '$1127.0.0.1');
}
