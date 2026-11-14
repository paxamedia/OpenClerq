import { describe, it, expect } from 'vitest';
import { reachFor } from './repos.js';
import type { AppAccess } from '../github/app.js';

const off: AppAccess = { state: 'off' };
const installed: AppAccess = { state: 'installed', slug: 'my-app', installationId: 7 };
const missing: AppAccess = { state: 'not_installed', slug: 'my-app' };
const unknown: AppAccess = { state: 'unknown', slug: 'my-app', reason: 'GitHub did not answer.' };

const reach = (auth: 'auto' | 'app' | 'token', app: AppAccess, present = true) =>
  reachFor({ auth, secret: 'GITHUB_TOKEN', present, app });

describe('how a run would reach a repository', () => {
  it('is the app where it is installed, unless the spec says token', () => {
    const app = { via: 'app', app: { slug: 'my-app', installationId: 7 } };
    expect(reach('auto', installed)).toEqual(app);
    expect(reach('app', installed)).toEqual(app);
    expect(reach('auto', installed, false)).toEqual(app);
    expect(reach('token', installed)).toEqual({ via: 'secret', secret: 'GITHUB_TOKEN' });
  });

  it('is the vault secret where the app is not installed, and says why', () => {
    expect(reach('auto', off)).toEqual({ via: 'secret', secret: 'GITHUB_TOKEN' });
    expect(reach('auto', missing)).toEqual({
      via: 'secret',
      secret: 'GITHUB_TOKEN',
      app: { slug: 'my-app' },
      note: 'The GitHub App my-app is connected but not installed on this repository.',
    });
  });

  it('is nothing where neither is there', () => {
    expect(reach('auto', off, false)).toEqual({
      via: 'none',
      secret: 'GITHUB_TOKEN',
      note: 'GITHUB_TOKEN is not in the vault.',
    });
    expect(reach('auto', missing, false)).toMatchObject({
      via: 'none',
      note: 'The GitHub App my-app is connected but not installed on this repository. GITHUB_TOKEN is not in the vault.',
    });
    expect(reach('token', installed, false)).toMatchObject({ via: 'none' });
  });

  it('is nothing for a spec that insists on the app that is not there', () => {
    expect(reach('app', off)).toMatchObject({
      via: 'none',
      note: expect.stringContaining('no GitHub App is connected'),
    });
    expect(reach('app', missing)).toMatchObject({
      via: 'none',
      app: { slug: 'my-app' },
      note: expect.stringContaining('not installed on this repository, so a run stops'),
    });
  });

  it('is unknown when GitHub could not say, and a run that pushes would stop', () => {
    expect(reach('auto', unknown)).toMatchObject({
      via: 'unknown',
      app: { slug: 'my-app' },
      secret: 'GITHUB_TOKEN',
      note: expect.stringContaining('stops until GitHub answers'),
    });
    expect(reach('app', unknown)).toMatchObject({ via: 'unknown', note: 'GitHub did not answer.' });
    // `token` never asks, so what GitHub says does not matter.
    expect(reach('token', unknown)).toEqual({ via: 'secret', secret: 'GITHUB_TOKEN' });
  });
});
