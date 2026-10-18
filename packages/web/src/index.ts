/**
 * @clerq/web — the Clerq interface. Importing it loads the bundled fonts, the
 * design tokens and the element defaults.
 */

import '@fontsource-variable/dm-sans';
import '@fontsource-variable/jetbrains-mono';
import './ui/tokens.css';
import './ui/base.css';

export { Icon, type IconProps } from './ui/Icon';
export { contrastRatio } from './ui/contrast';
export { Foundations } from './foundations/Foundations';
