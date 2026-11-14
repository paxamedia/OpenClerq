import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { automationsModule, OpenClerqApp } from '@clerq/web';
import { createFixtureClient, FIXTURE_NOW } from '@clerq/web/fixtures';
import { chatPlugin } from './index';

const draw = (modules: Parameters<typeof OpenClerqApp>[0]['modules']) =>
  renderToStaticMarkup(
    <OpenClerqApp
      client={createFixtureClient({ now: FIXTURE_NOW })}
      host={{ kind: 'web', version: '1.0.0', openUrl: () => undefined }}
      modules={modules}
    />
  );

/** The rail's entry for the console: the one list item that is its. */
const chatLinks = /<li><a[^>]*href="#\/m\/chat"[^>]*>(?:(?!<\/a>).)*<\/a><\/li>/gs;

describe('leaving the console out of the app’s bundled list', () => {
  it('takes the Chat page out and changes nothing else in the shell', () => {
    const without = draw([automationsModule]);
    const withChat = draw([automationsModule, chatPlugin]);
    expect(withChat).toContain('href="#/m/chat"');
    expect(without).not.toContain('href="#/m/chat"');
    expect(without).not.toContain('>Chat<');
    // What is left of the shell with the console is exactly the shell without it.
    expect(withChat.replace(chatLinks, '')).toBe(without);
  });

  it('leaves the rest of the pages as they are', () => {
    const without = draw([automationsModule]);
    for (const label of [
      'Home',
      'Inbox',
      'Automations',
      'Runs',
      'Repos',
      'Developer',
      'Settings',
    ]) {
      expect(without).toContain(`>${label}<`);
    }
  });
});
