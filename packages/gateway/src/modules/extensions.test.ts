import { describe, it, expect } from 'vitest';
import { parseExtensions } from './extensions.js';

describe('manifest extensions', () => {
  it('keep well-formed items per point', () => {
    const { extensions, warnings } = parseExtensions({
      extensions: {
        nav: [{ id: 'main', title: 'Hello', path: '/', order: 2 }],
        'record.panel': [
          { id: 'greetings', title: 'Greetings', types: ['core:person'], path: '/r/{ref}' },
        ],
        'record.action': [
          { id: 'count', title: 'Count', types: ['core:person'], trigger: 'count' },
        ],
        'inbox.item': [{ id: 'reply', kind: 'reply', title: 'Replies' }],
      },
    });
    expect(warnings).toEqual([]);
    expect(extensions.nav).toEqual([{ id: 'main', title: 'Hello', path: '/', order: 2 }]);
    expect(extensions['record.panel'][0].types).toEqual(['core:person']);
    expect(extensions['record.action'][0].trigger).toBe('count');
    expect(extensions['home.tile']).toEqual([]);
  });

  it('name what is wrong and leave it out', () => {
    const { extensions, warnings } = parseExtensions({
      extensions: {
        nav: [
          { id: 'a', title: 'A' },
          { id: 'a', title: 'A', path: '/' },
          { id: 'a', title: 'B', path: '/' },
        ],
        'record.panel': [{ id: 'p', title: 'P', types: ['person'], path: 'x' }],
        'inbox.item': [{ id: 'i', kind: 'nag', title: 'I' }],
        sidebar: [],
      },
    });
    expect(extensions.nav).toHaveLength(1);
    expect(extensions['record.panel']).toEqual([]);
    expect(warnings).toEqual([
      'extensions.nav[0] needs path.',
      'extensions.nav[2]: id "a" is used twice.',
      'extensions.record.panel[0].path should start with "/".',
      'extensions.record.panel[0].types should be "<module>:<type>" strings.',
      'extensions.record.panel[0] needs types, path.',
      'extensions.inbox.item[0].kind should be approval, reply, task or alert.',
      'extensions.inbox.item[0] needs kind.',
      'extensions.sidebar is not an extension point.',
    ]);
  });
});
