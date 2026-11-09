/**
 * A signal that scoped tokens may have stopped being valid (revoked, or
 * remote mode turned off), so long-lived connections such as the event
 * stream can check theirs at once instead of at the next heartbeat.
 */

type Listener = () => void;
const listeners = new Set<Listener>();

export function onTokensChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyTokensChanged(): void {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* one listener must not stop the rest */
    }
  }
}
