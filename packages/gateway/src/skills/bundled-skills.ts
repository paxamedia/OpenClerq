/**
 * The skills that ship with OpenClerq, by slug and the checksum (`sha256:<hex>`, over every file
 * of the skill's folder) they ship with. A skill with that slug whose files hash to exactly that
 * is trusted without the user having decided on it; any other change makes it `modified`, like
 * any skill. The slug alone approves nothing.
 *
 * Today that is the one skill in the repository's `skills/` folder, `example`. A test recomputes
 * every value from that folder, so editing a bundled skill without updating this list fails.
 */
export const BUNDLED_SKILLS: Readonly<Record<string, string>> = {
  example: 'sha256:0586d49e5f9656186dd7d51dbc1a54cd024e53ca8d8f071a0e28f4ffb7945c29',
};
