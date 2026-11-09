/**
 * Push to paired phones through ntfy (ntfy.sh or a self-hosted server), one
 * random topic per device.
 *
 * A message carries only a generic title and an id such as `approval:12`;
 * the app fetches the details over the authenticated API. So nothing private
 * passes through the push server, and a leaked topic reveals only that
 * something happened. A vault secret `NTFY_TOKEN`, when set, is sent as the
 * bearer token for a server that requires one.
 *
 * Pushing never holds up or fails the work that caused it: failures are
 * logged and dropped.
 */

import { subscribeEvents, type ClerqEvent } from '../events.js';
import { logger } from '../logger.js';
import { getSecret } from '../secrets-vault.js';
import { DEFAULT_TENANT } from '../tenant.js';
import { activeDevices, remoteSettings } from './devices.js';

export interface PushMessage {
  title: string;
  /** What it is about, e.g. `approval:12`, `inbox:inb_…`, `run:run_…`. */
  id: string;
  priority: 3 | 4;
}

const INBOX_TITLES: Record<string, string> = {
  approval: 'Approval needed',
  reply: 'New reply',
  task: 'New task',
  alert: 'New alert',
};

/** The push an event deserves, if any. */
export function pushFor(e: ClerqEvent): PushMessage | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.name) {
    case 'approval.requested':
      return { title: 'Approval needed', id: `approval:${p.id}`, priority: 4 };
    case 'inbox.item.created':
      return {
        title: INBOX_TITLES[String(p.kind)] ?? 'New inbox item',
        id: `inbox:${p.id}`,
        priority: p.kind === 'approval' || p.kind === 'alert' ? 4 : 3,
      };
    case 'run.failed':
      return e.context.runId
        ? { title: 'A run failed', id: `run:${e.context.runId}`, priority: 3 }
        : null;
    case 'notify.posted':
      return { title: `Notification from ${p.moduleId}`, id: `notify:${p.id}`, priority: 3 };
    default:
      return null;
  }
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number }>;

/** Publish to every active device of the event's tenant. Returns how many were sent. */
export async function publish(
  e: ClerqEvent,
  fetcher: Fetch = fetch as unknown as Fetch
): Promise<number> {
  const msg = pushFor(e);
  if (!msg || !remoteSettings().enabled) return 0;
  const tenant = e.context.tenantId ?? DEFAULT_TENANT;
  const devices = activeDevices().filter((d) => d.push && d.tenantId === tenant);
  const token = getSecret('NTFY_TOKEN');
  let sent = 0;
  await Promise.all(
    devices.map(async (d) => {
      try {
        const res = await fetcher(d.push!.server, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            topic: d.push!.topic,
            title: msg.title,
            message: msg.id,
            priority: msg.priority,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
        sent += 1;
      } catch (err) {
        logger.warn('Push to a device failed', {
          deviceId: d.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
  return sent;
}

/** Push as events happen. Returns a function that stops it. */
export function startPushPublisher(fetcher?: Fetch): () => void {
  return subscribeEvents((e) => {
    if (!pushFor(e)) return;
    void publish(e, fetcher).catch(() => undefined);
  });
}
