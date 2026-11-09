/**
 * ModuleHost: draws a module's pages in the shell. Bundled modules render
 * their own component; external module UIs (P3) will mount here in a frame.
 */

import { renderBundled, type ModuleRenderer } from '@clerq/web';

export const renderModule: ModuleRenderer = (module, props) => renderBundled(module, props);
