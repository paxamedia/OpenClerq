import { describe, it, expect } from 'vitest';
import { forgeAuthEnv, forgeOf, parseRemote, remoteTarget } from './forge.js';

describe('parseRemote', () => {
  it('reads the short forms', () => {
    expect(parseRemote('github:acme/app')).toEqual({
      forge: 'github',
      project: 'acme/app',
      url: 'https://github.com/acme/app.git',
      host: 'github.com',
    });
    expect(parseRemote('gitlab:group/sub/app')).toEqual({
      forge: 'gitlab',
      project: 'group/sub/app',
      url: 'https://gitlab.com/group/sub/app.git',
      host: 'gitlab.com',
    });
  });

  it('reads https URLs on github.com and gitlab.com, with or without .git', () => {
    expect(parseRemote('https://github.com/acme/app.git')).toEqual(
      remoteTarget('github', 'acme/app')
    );
    expect(parseRemote('https://github.com/acme/app/')).toEqual(remoteTarget('github', 'acme/app'));
    expect(parseRemote('https://github.com/acme/app.git/')).toEqual(
      remoteTarget('github', 'acme/app')
    );
    expect(parseRemote('https://GitLab.com/g/app')).toEqual(remoteTarget('gitlab', 'g/app'));
  });

  it('refuses what it cannot name safely', () => {
    for (const bad of [
      'github:acme',
      'github:acme/app/extra',
      'github:acme/..',
      'github:../app',
      'github:acme/ap p',
      'gitlab:solo',
      'https://example.com/acme/app.git',
      'http://github.com/acme/app',
      'git@github.com:acme/app.git',
      'local:/tmp/x',
    ]) {
      expect(parseRemote(bad), bad).toBeNull();
    }
  });
});

describe('forgeOf', () => {
  it('finds the project behind an origin URL, https or ssh', () => {
    expect(forgeOf('https://github.com/acme/app.git')).toEqual({
      forge: 'github',
      project: 'acme/app',
    });
    expect(forgeOf('https://user@github.com/acme/app')).toEqual({
      forge: 'github',
      project: 'acme/app',
    });
    expect(forgeOf('git@github.com:acme/app.git')).toEqual({
      forge: 'github',
      project: 'acme/app',
    });
    expect(forgeOf('ssh://git@github.com/acme/app.git')).toEqual({
      forge: 'github',
      project: 'acme/app',
    });
    expect(forgeOf('git@gitlab.com:g/sub/app.git')).toEqual({
      forge: 'gitlab',
      project: 'g/sub/app',
    });
    expect(forgeOf('https://example.com/acme/app.git')).toBeNull();
    expect(forgeOf(null)).toBeNull();
  });
});

describe('forgeAuthEnv', () => {
  it('scopes the token to the one host, as basic credentials git sends as a header', () => {
    const env = forgeAuthEnv('github', 'tok-123');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:tok-123').toString('base64')}`
    );
    const lab = forgeAuthEnv('gitlab', 'glpat-1');
    expect(lab.GIT_CONFIG_KEY_0).toBe('http.https://gitlab.com/.extraheader');
    expect(lab.GIT_CONFIG_VALUE_0).toContain(Buffer.from('oauth2:glpat-1').toString('base64'));
    // The token itself is never a plain value anywhere in the environment.
    expect(Object.values(env).join(' ')).not.toContain('tok-123');
  });
});
