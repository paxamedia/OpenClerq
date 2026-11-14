/**
 * First-party plugins that ship with OpenClerq, by id and the checksum
 * (`pluginChecksum`) they ship with. A plugin with one of these ids whose checksum
 * is exactly the listed one is approved when it is first seen, so it needs no
 * review; the same plugin with any file changed is treated like any other.
 *
 * `chat` is the chat console (`packages/plugin-chat`): a manifest and no server code,
 * so what its checksum covers is its `manifest.json`, the declaration of the core
 * endpoints and the kinds of memory its page uses. Its page is part of the app, not
 * of this folder. Editing a bundled plugin means updating its line here in the same
 * commit: `bundled-plugins.test.ts` recomputes every line from the plugin's folder.
 */
export const BUNDLED_PLUGINS: Readonly<Record<string, string>> = Object.freeze({
  chat: '9adbd8b49f1d89ddf7da6085d4b58002d6220df41746b35347e82c1bbf664718',
});
