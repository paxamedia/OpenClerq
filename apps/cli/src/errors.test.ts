import { describe, expect, it } from 'vitest';
import { GatewayError } from '@clerq/gateway-client';
import { CliError, EXIT, describeFailure } from './errors.js';

const url = 'https://clerq.example.com';
const refused = (status: number, body: Record<string, unknown> | null, message = 'Gateway') =>
  new GatewayError(message, status, body);

describe('describeFailure', () => {
  it('leaves a CliError as it is', () => {
    const e = new CliError('x', 7);
    expect(describeFailure(e, url)).toBe(e);
  });

  it('says a refused token plainly, and where to fix it', () => {
    const f = describeFailure(refused(401, { error: 'unauthorized' }), url);
    expect(f.exitCode).toBe(EXIT.failed);
    expect(f.message).toContain(`The gateway at ${url} refused the token`);
    expect(f.message).toContain('clerq login');
  });

  it('uses the gateway’s own message for a refusal, else its code', () => {
    expect(
      describeFailure(refused(400, { error: 'invalid_model', message: 'No such model.' }), url)
        .message
    ).toBe('No such model.');
    expect(describeFailure(refused(404, { error: 'not_found' }), url).message).toBe('not_found');
    expect(describeFailure(refused(409, null, 'Gateway 409: busy'), url).message).toBe(
      'Gateway 409: busy'
    );
  });

  it('turns a refused API version into exit 3', () => {
    const f = describeFailure(
      refused(
        400,
        { error: 'unsupported_api_version', supported: [2] },
        'This gateway speaks API 2; this app needs API 1.'
      ),
      url
    );
    expect(f).toMatchObject({
      exitCode: EXIT.gateway,
      message: 'This gateway speaks API 2; this app needs API 1.',
    });
  });

  it('says a failure of the gateway itself, with its status', () => {
    expect(describeFailure(refused(500, { error: 'x', message: 'boom' }), url).message).toBe(
      'The gateway had a problem (500): boom'
    );
  });

  it('turns a dropped connection or a timeout into exit 3 with the address', () => {
    const dropped = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:18790'),
    });
    const f = describeFailure(dropped, 'http://127.0.0.1:18790');
    expect(f.exitCode).toBe(EXIT.gateway);
    expect(f.message).toContain('Lost contact with the gateway at http://127.0.0.1:18790');
    expect(f.message).toContain('ECONNREFUSED');
    const slow = new DOMException('The gateway did not answer in time.', 'TimeoutError');
    expect(describeFailure(slow, url)).toMatchObject({
      exitCode: EXIT.gateway,
      message: `The gateway at ${url} did not answer in time.`,
    });
  });

  it('keeps any other error’s message, exit 1', () => {
    expect(describeFailure(new Error('odd'), url)).toMatchObject({ exitCode: 1, message: 'odd' });
    expect(describeFailure('text', url).message).toBe('text');
  });
});
