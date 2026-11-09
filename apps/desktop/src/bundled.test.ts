import { describe, expect, it } from 'vitest';
import { BUNDLED_MODULES, isTurnedOff } from './bundled';

const chat = BUNDLED_MODULES.find((m) => m.manifest.id === 'chat')!;
const automations = BUNDLED_MODULES.find((m) => m.manifest.id === 'automations')!;

describe('bundled modules', () => {
  it('ships Automations and Chat, each with a rail entry under /m/', () => {
    expect(BUNDLED_MODULES.map((m) => m.manifest.id)).toEqual(['automations', 'chat']);
    for (const m of BUNDLED_MODULES) {
      expect(m.ui.id).toBe(m.manifest.id);
      expect(m.ui.rail[0].path).toBe(`/m/${m.manifest.id}`);
    }
  });

  it('keeps a module on unless config.json turns it off', () => {
    expect(isTurnedOff({}, chat)).toBe(false);
    expect(
      isTurnedOff({ modules: [{ id: 'chat', name: 'Chat', description: '', enabled: true }] }, chat)
    ).toBe(false);
    expect(
      isTurnedOff(
        { modules: [{ id: 'chat', name: 'Chat', description: '', enabled: false }] },
        chat
      )
    ).toBe(true);
  });

  it('honours a 0.5 setting saved under the chat console’s old id', () => {
    const old = {
      modules: [{ id: 'chat-console', name: 'Chat console', description: '', enabled: false }],
    };
    expect(isTurnedOff(old, chat)).toBe(true);
    expect(isTurnedOff(old, automations)).toBe(false);
  });
});
