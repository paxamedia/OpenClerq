/**
 * @clerq/web/plugin-ui: what a plugin's UI may import from the app.
 *
 * A plugin whose page is a component in the app's own bundle (see `PluginUI` in
 * `@clerq/plugin-sdk/ui`) is drawn with the app's design system and reads the app's
 * data the way the core screens do. This file is the whole of that surface, listed by
 * name so that it is a decision and not an accident: the chat console, the reference
 * plugin, imports from here and from `@clerq/plugin-sdk`, `@clerq/gateway-client`,
 * `react` and `lucide-react`, and from nothing else in the app. A third-party plugin
 * can use exactly the same.
 *
 * Nothing here gives a plugin more than it was handed. `useClient()` is the client the shell
 * gave the plugin (a client limited to its declared endpoints when enforcement is on), not
 * the app's own. `useResource` reads and writes a live store that belongs to the plugin, and
 * `useInvalidate()` refetches that store's data: the shell's own store, and the events the
 * gateway sends, are not reachable from here. A plugin's props carry a reduced host.
 *
 * The plugin's CSS is its own. It may use the app's design tokens (`var(--space-3)`,
 * `var(--line)`, …) and these shared text classes: `page-hint`, `page-link`,
 * `page-link-button`, `page-mono`, `page-muted`, `tone-text-err`.
 */

// Controls and display
export { Button, IconButton } from './ui/Button';
export { Checkbox, SegmentedControl } from './ui/Choice';
export { CodeBlock, EmptyState, KeyValue, ProgressLine } from './ui/Display';
export { Input, Select, Textarea } from './ui/Field';
export { Dialog, Drawer } from './ui/Modal';
export { Split } from './ui/Split';
export { StatusTag, type Tone } from './ui/Status';
export { useToast } from './ui/Toast';
export { cx } from './ui/cx';
export { CompareBars, metricText, metricValue } from './charts/charts';

// The page frame and its states
export {
  ErrorState,
  Loaded,
  Page,
  PageHeader,
  PageSkeleton,
  PHONE_QUERY,
  useMedia,
} from './shell/layout';
export { When } from './screens/common';

// The client the plugin was given, live data of its own, and the router
export { useClient } from './app/client';
export { useResource, type Resource } from './app/live';
export { useInvalidate } from './app/plugin-surface';
export { navigate } from './app/router';

// Words and numbers, formatted as the app does
export { describeCron } from './app/cron';
export { duration, errorMessage, exactTime, money, tokens } from './app/format';
