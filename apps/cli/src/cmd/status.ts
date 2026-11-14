/** `clerq status`: what the CLI would talk to, and whether that works. Never prints the token. */

import { API_VERSION, GatewayError, SUPPORTED_API_VERSIONS, gateway } from '@clerq/gateway-client';
import type { Call } from '../args.js';
import { aim, resolve, unusable } from '../connect.js';
import type { Context } from '../context.js';
import { EXIT } from '../errors.js';
import { tokenWords, urlWords } from '../connection.js';
import { CLI_VERSION } from '../version.js';

type TokenState = 'accepted' | 'refused' | 'not-allowed' | 'none' | 'not-checked';

const TOKEN_WORDS: Record<TokenState, string> = {
  accepted: 'accepted',
  refused: 'refused by the gateway',
  'not-allowed': 'known, but not allowed to list approvals (the CLI needs the gateway token)',
  none: 'none to send',
  'not-checked': 'not checked',
};

export async function run(ctx: Context, _call: Call): Promise<number> {
  const { out, home } = ctx;
  const resolved = resolve(ctx);
  aim(resolved);

  const compat = await gateway.checkCompatibility();
  let schema: number | null = null;
  if (compat.ok) {
    try {
      schema = (await gateway.version()).store.schema;
    } catch {
      /* the compatibility answer already said it speaks our version */
    }
  }

  let token: TokenState = 'not-checked';
  if (!resolved.token) token = 'none';
  else if (compat.ok) {
    try {
      await gateway.approvals();
      token = 'accepted';
    } catch (e) {
      if (e instanceof GatewayError && e.status === 401) token = 'refused';
      else if (e instanceof GatewayError && e.status === 403) token = 'not-allowed';
      else throw e;
    }
  }

  out.data({
    url: resolved.url,
    profile: resolved.profile,
    source: { url: resolved.urlSource, token: resolved.tokenSource },
    cli: {
      version: CLI_VERSION,
      api: { version: API_VERSION, supported: [...SUPPORTED_API_VERSIONS] },
    },
    gateway:
      compat.ok || compat.gateway ? { version: compat.gateway, api: compat.api, schema } : null,
    compatibility: { ok: compat.ok, kind: compat.kind, reason: compat.reason },
    token: { present: resolved.token !== null, state: token, source: resolved.tokenSource },
  });

  const rows: Array<[string, string]> = [
    ['Gateway', `${resolved.url}  (${urlWords(resolved, home)})`],
    ['Profile', resolved.profile ?? 'none in use'],
    ['Token', tokenWords(resolved, home)],
    [
      'Gateway is',
      compat.gateway || compat.api
        ? `OpenClerq ${compat.gateway ?? '?'}, API ${compat.api?.version ?? '?'} (serves ${compat.api?.supported.join(', ') ?? '?'})${schema !== null ? `, store schema ${schema}` : ''}`
        : 'not answering',
    ],
    ['This CLI', `${CLI_VERSION}, API ${API_VERSION}`],
    ['Compatible', compat.ok ? 'yes' : 'no'],
    ['Token is', TOKEN_WORDS[token]],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) out.say(`${out.bold(k.padEnd(width))}  ${v}`);

  if (!compat.ok) {
    out.error(unusable(compat, resolved.url).message);
    return EXIT.gateway;
  }
  if (token === 'none') {
    out.error(
      `There is no token for ${resolved.url}. Run \`clerq login\`, or set CLERQ_GATEWAY_TOKEN.`
    );
    return EXIT.failed;
  }
  return token === 'accepted' ? EXIT.ok : EXIT.failed;
}
