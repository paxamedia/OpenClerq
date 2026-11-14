/** The two reads the console shares between its pages: the providers and the conversations. */

import { useClient, useResource } from '@clerq/web/plugin-ui';

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
