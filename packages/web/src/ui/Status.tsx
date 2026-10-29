import type { ReactNode } from 'react';
import { cx } from './cx';
import './Status.css';

export type Tone = 'muted' | 'accent' | 'ok' | 'warn' | 'err';

export interface StatusTagProps {
  tone: Tone;
  children: ReactNode;
  className?: string;
}

/** A 6px square in the state's colour, then the label in plain text. */
export function StatusTag({ tone, children, className }: StatusTagProps) {
  return (
    <span className={cx('ui-status', `ui-status--${tone}`, className)}>
      <span className="ui-status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/** What each run state is called on screen, and its colour. */
export const RUN_STATES: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'muted' },
  leased: { label: 'Queued', tone: 'muted' },
  preparing: { label: 'Preparing', tone: 'accent' },
  executing: { label: 'Running', tone: 'accent' },
  verifying: { label: 'Checking', tone: 'accent' },
  publishing: { label: 'Publishing', tone: 'accent' },
  awaiting_approval: { label: 'Needs approval', tone: 'warn' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'err' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

/** A run state's label and colour. An unknown state is shown in words, muted. */
export function runState(state: string): { label: string; tone: Tone } {
  const known = RUN_STATES[state];
  if (known) return known;
  const words = state.replace(/_/g, ' ').trim();
  return { label: words.charAt(0).toUpperCase() + words.slice(1), tone: 'muted' };
}

export function RunStatus({ state, className }: { state: string; className?: string }) {
  const { label, tone } = runState(state);
  return (
    <StatusTag tone={tone} className={className}>
      {label}
    </StatusTag>
  );
}
