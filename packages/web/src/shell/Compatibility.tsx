/**
 * The notice shown when the gateway cannot serve this app: it speaks another
 * API version, or it is older than the first versioned release. The check runs
 * once when the app starts (see docs/API.md); it says nothing when the gateway
 * is fine, and nothing when nothing answers, since the status bar already says
 * the background service is not responding.
 */

import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Icon } from '../ui/Icon';
import { useClient, type GatewayClient } from '../app/client';

/** How long to wait before asking again while nothing answers, as the service may still be starting. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

/**
 * Ask the gateway whether it can serve this app, and call `onProblem` with the
 * reason in plain words, or null. Asks again, after each delay, only while
 * nothing answers. Returns a function that stops it.
 */
export function watchCompatibility(
  client: GatewayClient,
  onProblem: (reason: string | null) => void,
  delaysMs: readonly number[] = RETRY_DELAYS_MS
): () => void {
  // A client from before 1.0, or the phone app's own, may not have the check.
  if (typeof client.checkCompatibility !== 'function') return () => undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ask = async (attempt: number): Promise<void> => {
    let result: Awaited<ReturnType<GatewayClient['checkCompatibility']>>;
    try {
      result = await client.checkCompatibility();
    } catch {
      return; // no answer to speak of; the status bar covers a service that is down
    }
    if (stopped) return;
    if (result.kind === 'unreachable') {
      if (attempt < delaysMs.length)
        timer = setTimeout(() => void ask(attempt + 1), delaysMs[attempt]);
      return;
    }
    onProblem(result.ok ? null : result.reason);
  };
  void ask(0);

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** The reason, in a bar under the top bar; nothing when there is none. */
export function CompatibilityNotice({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <div className="shell-notice" role="alert">
      <Icon glyph={TriangleAlert} className="shell-notice-icon" />
      <p className="shell-notice-text">{reason}</p>
    </div>
  );
}

/** Checks the gateway once when the app starts and shows what is wrong, if anything. */
export function CompatibilityBanner() {
  const client = useClient();
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => watchCompatibility(client, setReason), [client]);
  return <CompatibilityNotice reason={reason} />;
}
