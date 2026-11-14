import { afterEach, describe, expect, it } from 'vitest';
import { githubUrl, githubWebBase, settingsUrl, installUrl } from './config.js';

const saved = process.env.CLERQ_GITHUB_WEB;
afterEach(() => {
  if (saved === undefined) delete process.env.CLERQ_GITHUB_WEB;
  else process.env.CLERQ_GITHUB_WEB = saved;
});

describe('an address GitHub gave', () => {
  it('is kept only when it is https on github.com, with nothing hidden in it', () => {
    delete process.env.CLERQ_GITHUB_WEB;
    expect(githubWebBase()).toBe('https://github.com');
    expect(githubUrl('https://github.com/apps/my-app')).toBe('https://github.com/apps/my-app');
    expect(githubUrl('https://github.com/settings/installations/7?x=1#top')).toBe(
      'https://github.com/settings/installations/7?x=1#top'
    );
    for (const bad of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'http://github.com/apps/x',
      'https://evil.example/apps/x',
      'https://github.com.evil.example/apps/x',
      'https://evil.example/https://github.com/apps/x',
      'https://github.com@evil.example/apps/x',
      'https://user:pw@github.com/apps/x',
      'https://github.com:8443/apps/x',
      '//evil.example/apps/x',
      '/apps/x',
      'github.com/apps/x',
      '',
      'not a url',
      null,
      undefined,
      42,
      { href: 'https://github.com/' },
    ]) {
      expect([bad, githubUrl(bad)]).toEqual([bad, null]);
    }
  });

  it('is judged against the website the gateway is set to, so a test server can stand in', () => {
    process.env.CLERQ_GITHUB_WEB = 'http://github.test';
    expect(githubUrl('http://github.test/apps/x')).toBe('http://github.test/apps/x');
    expect(githubUrl('https://github.com/apps/x')).toBeNull();
    expect(githubUrl('http://github.test.evil.example/apps/x')).toBeNull();
  });
});

describe('the addresses made here', () => {
  it('stay on GitHub’s website whatever the slug and the owner say', () => {
    for (const [slug, login] of [
      ['my-app', 'acme'],
      ['x', '../../evil.example'],
      ['x', 'a/b?c#d'],
      ['x', 'evil.example/../..'],
    ]) {
      for (const url of [
        settingsUrl({ slug, owner: { login, type: 'Organization' } }),
        settingsUrl({ slug, owner: { login, type: 'User' } }),
        installUrl({ slug }),
      ]) {
        expect([url, new URL(url).origin]).toEqual([url, 'https://github.com']);
        expect(githubUrl(url)).toBe(url);
      }
    }
  });
});
