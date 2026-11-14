/**
 * First-party plugins that ship with OpenClerq, by id and the checksum
 * (`pluginChecksum`) they ship with. A plugin with one of these ids whose checksum
 * is exactly the listed one is approved when it is first seen, so it needs no
 * review; the same plugin with any file changed is treated like any other.
 *
 * None is bundled yet: the list is empty. The chat console moves onto the plugin
 * SDK in the next task and is the first. Editing a bundled plugin means updating
 * its line here in the same commit (a test recomputes every line).
 */
export const BUNDLED_PLUGINS: Readonly<Record<string, string>> = Object.freeze({});
