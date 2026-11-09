/**
 * The reads the screens share, over useResource. Newer gateway fields are
 * filled in here when the gateway does not send them yet (see AutomationInfo).
 */

import type { Approval, RunSummary } from '@clerq/gateway-client';
import { useClient, type AutomationInfo, type GatewayClient } from './client';
import { useResource, type Resource } from './live';

export const DAY_MS = 86_400_000;

export async function loadAutomations(client: GatewayClient): Promise<AutomationInfo[]> {
  return (await client.automations()).automations;
}

export function useAutomations(): Resource<AutomationInfo[]> {
  const client = useClient();
  return useResource('automations', () => loadAutomations(client), { on: ['automations'] });
}

/** Runs created at or after `since`, newest first. */
export async function loadRunsSince(
  client: GatewayClient,
  since: Date,
  limit = 500
): Promise<RunSummary[]> {
  return (await client.runs(limit, { since })).runs;
}

/** Midnight at the start of the day `days` days before today. */
export function daysAgo(days: number, now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - days);
  return d;
}

export function monthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/**
 * The runs behind Home, the status bar and the 7-day views: back to the
 * earlier of 14 days ago and the start of the month.
 */
export function useRecentRuns(): Resource<RunSummary[]> {
  const client = useClient();
  return useResource(
    'runs:recent',
    () => {
      const a = daysAgo(13);
      const b = monthStart();
      return loadRunsSince(client, a < b ? a : b);
    },
    { on: ['runs'] }
  );
}

export function useApprovals(): Resource<Approval[]> {
  const client = useClient();
  return useResource('approvals', async () => (await client.approvals()).approvals, {
    on: ['approvals'],
  });
}

export function useHealth() {
  const client = useClient();
  return useResource('health', () => client.health(), { on: ['health'] });
}

export function useRun(id: string | null) {
  const client = useClient();
  return useResource(id ? `run:${id}` : null, () => client.run(id as string), {
    on: ['runs'],
    runId: id ?? undefined,
  });
}

export function useProviders() {
  const client = useClient();
  return useResource('providers', () => client.providers(), { on: ['health'] });
}

export function useSessions() {
  const client = useClient();
  return useResource('sessions', async () => (await client.sessions()).sessions, {
    on: ['sessions'],
  });
}
