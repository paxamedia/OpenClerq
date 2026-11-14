import { describe, expect, it } from 'vitest';
import tauriConf from '../src-tauri/tauri.conf.json';
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

  it('carries a plugin’s manifest to the gateway for each bundled module that is one, and for no other', () => {
    // The gateway approves a bundled plugin by its checksum; the manifest it checks is the one
    // the app carries. Taking Chat out of BUNDLED_MODULES takes its manifest out with it.
    const carried = Object.values(tauriConf.bundle.resources as Record<string, string>)
      .filter((to) => to.startsWith('bundled-plugins/'))
      .map((to) => to.split('/')[1])
      .sort();
    expect(carried).toEqual(['chat']);
    expect(BUNDLED_MODULES.map((m) => m.manifest.id)).toEqual(expect.arrayContaining(carried));
  });
});
