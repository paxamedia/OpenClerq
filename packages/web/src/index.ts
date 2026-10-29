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
