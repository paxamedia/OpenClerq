/** `clerq-server version`: the release, the API it speaks and the store schema it knows. */

export interface ServerVersion {
  version: string;
  api: { version: number; supported: number[] };
  store: { schema: number };
}

export async function serverVersion(): Promise<ServerVersion> {
  // Loaded here, not at the top, so `healthcheck` stays small and quick.
  const [{ GATEWAY_VERSION }, { API_VERSION, SUPPORTED_API_VERSIONS }, { newestKnownSchema }] =
    await Promise.all([
      import('@clerq/gateway'),
      import('@clerq/gateway-client/protocol'),
      import('@clerq/store'),
    ]);
  return {
    version: GATEWAY_VERSION,
    api: { version: API_VERSION, supported: [...SUPPORTED_API_VERSIONS] },
    store: { schema: newestKnownSchema() },
  };
}

export function versionText(v: ServerVersion): string {
  return [
    `clerq-server ${v.version}`,
    `API version: ${v.api.version} (supported: ${v.api.supported.join(', ')})`,
    `Store schema: ${v.store.schema}`,
    '',
  ].join('\n');
}
