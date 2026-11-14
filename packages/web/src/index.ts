/**
 * @clerq/web — the Clerq interface. Importing it loads the bundled fonts, the
 * design tokens and the element defaults.
 */

import '@fontsource-variable/dm-sans';
import '@fontsource-variable/jetbrains-mono';
import './ui/tokens.css';
import './ui/base.css';

export { Icon, type IconProps } from './ui/Icon';
export {
  Button,
  IconButton,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  type IconButtonProps,
} from './ui/Button';
export {
  Input,
  Textarea,
  Select,
  type InputProps,
  type SelectProps,
  type TextareaProps,
} from './ui/Field';
export {
  Checkbox,
  Switch,
  SegmentedControl,
  type CheckboxProps,
  type SegmentOption,
  type SegmentedControlProps,
  type SwitchProps,
} from './ui/Choice';
export { Tabs, type TabItem, type TabsProps } from './ui/Tabs';
export { Table, sortRows, type Column, type SortState, type TableProps } from './ui/Table';
export {
  StatusTag,
  RunStatus,
  RUN_STATES,
  runState,
  type StatusTagProps,
  type Tone,
} from './ui/Status';
export {
  KeyValue,
  CodeBlock,
  Skeleton,
  EmptyState,
  ProgressLine,
  type CodeBlockProps,
  type EmptyStateProps,
  type KeyValueItem,
  type SkeletonProps,
} from './ui/Display';
export { Tooltip, type TooltipProps } from './ui/Tooltip';
export {
  Popover,
  Menu,
  type MenuItem,
  type MenuProps,
  type PopoverProps,
  type TriggerProps,
} from './ui/Popover';
export { Dialog, Drawer, type DialogProps, type DrawerProps } from './ui/Modal';
export { ToastProvider, useToast, type ToastOptions } from './ui/Toast';
export { place, useFloating, useDismiss, type Placement } from './ui/floating';
export { nextIndex } from './ui/roving';
export { contrastRatio } from './ui/contrast';
export { Foundations } from './foundations/Foundations';
export { Split, type SplitProps } from './ui/Split';

// The app, its contract with its host, and the modules that ship with it.
export { OpenClerqApp, type OpenClerqAppProps } from './App';
export {
  PLUGIN_TOKEN_TTL_S,
  ScopedToken,
  defaultScopedClient,
  usePluginAccess,
  whyNotRunning,
  type MintedToken,
  type PluginAccess,
  type ScopedClientFactory,
} from './app/plugin-access';
export {
  useClient,
  useHost,
  type AppConfig,
  type AutomationInfo,
  type GatewayClient,
  type Host,
  type UpdateResult,
} from './app/client';
export {
  moduleBase,
  renderBundled,
  type ModuleContext,
  type ModuleProps,
  type ModuleRenderer,
  type ModuleUI,
  type PaletteCommand,
  type RailEntry,
} from './app/modules';
export {
  href,
  isUnder,
  Link,
  navigate,
  parseHash,
  useRoute,
  withQuery,
  type Route,
} from './app/router';
export {
  LiveProvider,
  LiveStore,
  connectStream,
  familiesOf,
  useLive,
  useResource,
  useStreamState,
  type Family,
  type GatewayEvent,
  type Resource,
  type StreamState,
} from './app/live';
export { applyTheme, setTheme, storedTheme, useTheme, THEME_KEY, type Theme } from './app/theme';
export { describeCron, nextFirings, parseCron } from './app/cron';
export * as format from './app/format';
export { automationsModule, AUTOMATIONS_ID } from './screens/automations';

// Screens on their own, for an app that lays them out itself.
export { Home } from './screens/home/Home';
export { Runs } from './screens/runs/Runs';
export { Repos } from './screens/repos/Repos';
export { Inbox, ApprovalDetail, useInbox } from './screens/inbox/Inbox';
export { Records } from './screens/records/Records';
export { ModuleFrame, moduleUiUrl, type ModuleFrameProps } from './shell/ModuleFrame';
export {
  useExtensions,
  useGatewayModules,
  moduleRoute,
  hitRoute,
  fillRef,
  refId,
  forRecord,
} from './app/extensions';
export { Settings } from './screens/settings/Settings';
export { Developer } from './screens/developer/Developer';
export { AutomationsScreen } from './screens/automations/Automations';
export { Shell, type ShellProps } from './shell/Shell';
export {
  Page,
  PageHeader,
  Section,
  ErrorState,
  Loaded,
  PHONE_QUERY,
  useMedia,
} from './shell/layout';
export * from './charts/charts';
export { installedModule, gatewayModule } from './screens/InstalledModule';
