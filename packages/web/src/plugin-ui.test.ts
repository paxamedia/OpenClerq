import { describe, expect, it } from 'vitest';
import * as pluginUi from './plugin-ui';

/**
 * What a plugin's UI may import from the app (`@clerq/web/plugin-ui`). The list is pinned so that
 * it grows on purpose: a name added here is a name every plugin can rely on, and one removed
 * breaks them. Update it in the same commit as the change, and PLUGINS.md with it.
 */
const SURFACE = [
  'Button',
  'Checkbox',
  'CodeBlock',
  'CompareBars',
  'Dialog',
  'Drawer',
  'EmptyState',
  'ErrorState',
  'IconButton',
  'Input',
  'KeyValue',
  'Loaded',
  'PHONE_QUERY',
  'Page',
  'PageHeader',
  'PageSkeleton',
  'ProgressLine',
  'SegmentedControl',
  'Select',
  'Split',
  'StatusTag',
  'Textarea',
  'When',
  'cx',
  'describeCron',
  'duration',
  'errorMessage',
  'exactTime',
  'metricText',
  'metricValue',
  'money',
  'navigate',
  'tokens',
  'useClient',
  'useInvalidate',
  'useMedia',
  'useResource',
  'useToast',
];

describe('the plugin UI surface', () => {
  it('is exactly the pinned list', () => {
    expect(Object.keys(pluginUi).sort()).toEqual([...SURFACE].sort());
  });

  it('gives a plugin nothing that reaches past the client it was handed', () => {
    // No host (so no config, no updater, no notifications), no app-wide client, and no way to the shell's
    // live store: `useLive` would hand a plugin the store the shell decides things from.
    for (const name of [
      'useHost',
      'useLive',
      'LiveStore',
      'LiveProvider',
      'LiveContext',
      'EnvironmentContext',
      'gateway',
    ]) {
      expect(name in pluginUi, name).toBe(false);
    }
  });
});
