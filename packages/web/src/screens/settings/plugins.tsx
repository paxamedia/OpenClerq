/**
 * Settings → Plugins: the modules and plugins OpenClerq found, what each asks
 * for, whether you approved it, and the switch that makes permissions enforced.
 *
 * Reviewing a plugin shows what it asks for in plain words, and what changed since
 * you last approved it. Approving names exactly what you saw (the hashes the list
 * gave), so an approval cannot cover a later change.
 */

import { useState } from 'react';
import { Check, Power, PowerOff, ShieldCheck } from 'lucide-react';
import { GatewayError, type PluginInfo, type PluginState } from '@clerq/gateway-client';
import { describePermissions } from '@clerq/plugin-sdk/manifest';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Choice';
import { EmptyState } from '../../ui/Display';
import { Dialog } from '../../ui/Modal';
import { StatusTag, type Tone } from '../../ui/Status';
import { useToast } from '../../ui/Toast';
import { useClient, type GatewayClient } from '../../app/client';
import { errorMessage } from '../../app/format';
import { useLive, useResource } from '../../app/live';
import { Loaded, Section } from '../../shell/layout';
import { When } from '../common';

/**
 * What the switch does and does not do. One paragraph, shown beside it in Plugins and in Skills:
 * the setting is one, for both.
 */
export const ENFORCE_NOTE =
  'Off, what a plugin or a skill declares is shown and recorded, and nothing is blocked or narrowed (a skill you have blocked is still not used). On, a plugin you have not approved, or that has changed since you approved it, does not run, and what it does through OpenClerq (its secrets, background services, programs, network calls and files) has to stay within what it declared; a skill you have not trusted, or that has changed since you trusted it, is not used, and a trusted skill’s declarations narrow the tools a chat is offered to the ones it lists, limit the chat’s file tools to the paths it lists and, in a Sandboxed chat, send its commands’ network through a proxy that allows only the hosts it lists (macOS filters by port, not by host). Plugins run inside OpenClerq’s background service with its access, so this is not a sandbox: it makes a plugin’s declarations true for one that behaves, and catches mistakes. A plugin can still use the computer directly. A skill is text for the model, not code: trusting it says the text is the text you read, not that the model will follow only that, and commands in a chat that is not Sandboxed are not limited.';

export const STATE_LABEL: Record<PluginState, string> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  awaiting_approval: 'Waiting for approval',
  failed: 'Failed',
  refused: 'Not supported',
};

export function stateTone(state: PluginState): Tone {
  return state === 'enabled'
    ? 'ok'
    : state === 'failed'
      ? 'err'
      : state === 'awaiting_approval'
        ? 'warn'
        : 'muted';
}

/** Where the approval stands, in words. Nothing for a plugin that cannot run. */
export function approvalNote(p: PluginInfo): { label: string; tone: Tone } | null {
  if (p.state === 'refused' || (p.state === 'failed' && p.approval.status === 'not_approved')) {
    return null;
  }
  switch (p.approval.status) {
    case 'approved':
      return {
        label: p.approval.approvedBy === 'bundled' ? 'Approved, ships with OpenClerq' : 'Approved',
        tone: 'ok',
      };
    case 'changed':
      return { label: 'Changed since you approved it', tone: 'warn' };
    default:
      return { label: 'Not approved', tone: 'warn' };
  }
}

export type RowAction = 'review' | 'enable' | 'disable';

/** The buttons a plugin's row offers, in order. */
export function rowActions(p: PluginInfo): RowAction[] {
  switch (p.state) {
    case 'enabled':
      return p.approval.status === 'approved' ? ['disable'] : ['review', 'disable'];
    case 'awaiting_approval':
      return ['review', 'disable'];
    case 'disabled':
      return ['enable'];
    case 'failed':
      return ['enable'];
    default:
      return [];
  }
}

/** The label of the Enable button: a plugin that failed is tried again. */
export const enableLabel = (p: PluginInfo): string =>
  p.state === 'failed' ? 'Try again' : 'Enable';

/** Names of the plugins that would stop if enforcement were turned on now. */
export function wouldStop(plugins: PluginInfo[]): string[] {
  return plugins
    .filter((p) => p.state === 'enabled' && p.approval.status !== 'approved')
    .map((p) => p.name);
}

/** The first characters of a hash, enough to compare by eye. */
export const shortHash = (h: string | null): string => (h ? h.slice(0, 12) : '—');

/** Shown when the list now says something other than what the dialog was opened on. */
export const CHANGED_NOTE =
  'This plugin changed while you were reviewing it. Close this and review it again: nothing shown here can be approved.';

/** Whether the plugin now listed is not the one that was opened for review (changed, or gone). */
export function changedSince(
  opened: Pick<PluginInfo, 'checksum' | 'permissionsHash'>,
  now: Pick<PluginInfo, 'checksum' | 'permissionsHash'> | undefined
): boolean {
  return !now || now.checksum !== opened.checksum || now.permissionsHash !== opened.permissionsHash;
}

const STALE =
  'The plugin changed while you were reviewing it. Nothing was approved. Review it again.';

/**
 * Approve exactly what was reviewed: the hashes the list showed. A plugin that changed
 * since answers 409, and the reviewer is asked to look again.
 */
export async function approveReviewed(
  client: Pick<GatewayClient, 'approvePlugin'>,
  p: Pick<PluginInfo, 'id' | 'permissionsHash' | 'checksum'>
): Promise<{ ok: true } | { ok: false; stale: boolean; message: string }> {
  if (!p.permissionsHash || !p.checksum) {
    return {
      ok: false,
      stale: false,
      message: 'Its files could not be read, so it cannot be approved.',
    };
  }
  try {
    await client.approvePlugin(p.id, { permissionsHash: p.permissionsHash, checksum: p.checksum });
    return { ok: true };
  } catch (e) {
    const stale =
      e instanceof GatewayError && e.status === 409 && e.body?.error === 'approval_stale';
    return { ok: false, stale, message: stale ? STALE : errorMessage(e) };
  }
}

// ---------------------------------------------------------------------------
// Review

/** What a plugin asks for, one permission at a time, in plain words. */
export function PermissionList({ plugin }: { plugin: PluginInfo }) {
  const lines = describePermissions(plugin.permissions);
  if (lines.length === 0) {
    return <p className="page-hint">It asks for no permissions.</p>;
  }
  return (
    <ul className="plugin-permissions" aria-label="What it asks for">
      {lines.map((line) => (
        <li key={line.key}>
          <span className="plugin-permission-label">{line.label}</span>
          <span className="page-hint">{line.summary}</span>
          {line.items.length > 0 && (
            <ul className="plugin-permission-items">
              {line.items.map((item) => (
                <li key={item}>
                  <code>{item}</code>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/** What changed since the last approval: the code, the version and each permission. */
export function WhatChanged({ plugin }: { plugin: PluginInfo }) {
  const { approval } = plugin;
  if (approval.status !== 'changed') return null;
  const notes: string[] = [];
  if (approval.changes.version) {
    notes.push(
      `The version went from ${approval.approvedVersion ?? 'unknown'} to ${plugin.version ?? 'unknown'}.`
    );
  }
  if (approval.changes.code) notes.push('Its code changed.');
  return (
    <div className="plugin-changes">
      <h3 className="settings-subtitle">What changed since you approved it</h3>
      <ul aria-label="What changed">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
        {approval.permissionChanges.map((c) => (
          <li
            key={`${c.key}:${c.item}:${c.change}`}
            className={c.change === 'added' ? 'plugin-added' : undefined}
          >
            {c.text}
          </li>
        ))}
        {approval.changes.permissions && approval.permissionChanges.length === 0 && (
          <li>Its permissions changed.</li>
        )}
      </ul>
    </div>
  );
}

export function ReviewDialog({
  plugin,
  enforce,
  open,
  busy,
  error,
  changed,
  onClose,
  onApprove,
}: {
  plugin: PluginInfo;
  enforce: boolean;
  open: boolean;
  busy?: boolean;
  error?: string | null;
  /** The list now shows something else than what this dialog was opened on. */
  changed?: boolean;
  onClose: () => void;
  onApprove: () => void;
}) {
  const approved = plugin.approval.status === 'approved';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={`${approved ? 'Permissions' : 'Review'} · ${plugin.name}`}
      description={
        approved
          ? 'This is what the plugin asks for, and you approved exactly this.'
          : 'Check what this plugin asks for before you approve it.'
      }
      actions={
        approved ? (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={Check}
              busy={busy}
              disabled={changed}
              onClick={onApprove}
            >
              Approve
            </Button>
          </>
        )
      }
    >
      <div className="plugin-review">
        {plugin.description && <p>{plugin.description}</p>}
        <WhatChanged plugin={plugin} />
        <h3 className="settings-subtitle">What it asks for</h3>
        <PermissionList plugin={plugin} />
        {plugin.kind === 'legacy' && (
          <p className="page-hint">
            A legacy module: it was written before plugins had a manifest version. It is checked the
            same way.
          </p>
        )}
        {plugin.warnings.length > 0 && (
          <ul className="plugin-warnings" aria-label="Warnings">
            {plugin.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        <p className="page-hint">
          Version {plugin.version ?? 'unknown'}. Code checksum{' '}
          <code>{shortHash(plugin.checksum)}</code>, permissions{' '}
          <code>{shortHash(plugin.permissionsHash)}</code>. Approving records exactly this version
          and these permissions; if either changes you will be asked again.
        </p>
        {!approved && (
          <p className="page-hint">
            {enforce
              ? 'Enforcement is on: the plugin will not run until you approve it.'
              : 'Enforcement is off, so this plugin runs whether or not you approve it. The approval is recorded, and counts if you turn enforcement on.'}
          </p>
        )}
        {changed && (
          <p className="tone-text-err" role="alert">
            {CHANGED_NOTE}
          </p>
        )}
        {error && (
          <p className="tone-text-err" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The list

export function PluginRow({
  plugin,
  busy,
  onReview,
  onEnable,
  onDisable,
  now,
}: {
  plugin: PluginInfo;
  busy?: boolean;
  onReview: () => void;
  onEnable: () => void;
  onDisable: () => void;
  now?: number;
}) {
  const note = approvalNote(plugin);
  const actions = rowActions(plugin);
  return (
    <li className="plugin-row">
      <div className="plugin-main">
        <span className="plugin-name">
          {plugin.name}
          {plugin.version && <span className="plugin-version">{plugin.version}</span>}
          {plugin.kind === 'legacy' && (
            <StatusTag tone="muted" className="plugin-kind">
              Legacy
            </StatusTag>
          )}
        </span>
        {plugin.description && <span className="page-hint">{plugin.description}</span>}
        {plugin.reason && plugin.state !== 'enabled' && (
          <span className={plugin.state === 'failed' ? 'tone-text-err' : 'page-hint'}>
            {plugin.reason}
          </span>
        )}
        {plugin.needsRestart && (
          <span className="page-hint">
            Its files changed on disk. Disable and enable it, or restart OpenClerq, to run the new
            version.
          </span>
        )}
        {plugin.approval.approvedAt && plugin.approval.status === 'approved' && (
          <span className="page-hint">
            Approved <When at={plugin.approval.approvedAt} now={now} />
          </span>
        )}
      </div>
      <div className="plugin-tags">
        <StatusTag tone={stateTone(plugin.state)}>{STATE_LABEL[plugin.state]}</StatusTag>
        {note && <StatusTag tone={note.tone}>{note.label}</StatusTag>}
      </div>
      <div className="plugin-actions">
        {actions.includes('review') && (
          <Button size="sm" icon={ShieldCheck} onClick={onReview}>
            Review
          </Button>
        )}
        {actions.includes('enable') && (
          <Button size="sm" icon={Power} busy={busy} onClick={onEnable}>
            {enableLabel(plugin)}
          </Button>
        )}
        {actions.includes('disable') && (
          <Button size="sm" variant="ghost" icon={PowerOff} busy={busy} onClick={onDisable}>
            Disable
          </Button>
        )}
        {!actions.includes('review') && plugin.state !== 'refused' && (
          <Button size="sm" variant="ghost" onClick={onReview}>
            Permissions
          </Button>
        )}
      </div>
    </li>
  );
}

export function EnforceSwitch({
  enforce,
  busy,
  onChange,
}: {
  enforce: boolean;
  busy?: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="plugin-enforce">
      <Switch
        checked={enforce}
        onChange={onChange}
        disabled={busy}
        label="Enforce what plugins and skills declare"
      />
      <p className="page-hint">{ENFORCE_NOTE}</p>
    </div>
  );
}

export function EnforceDialog({
  open,
  names,
  skillNames,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  /** Plugins that would stop; leave out when they are not known here. */
  names?: string[];
  /** Skills that would stop being used; leave out when they are not known here. */
  skillNames?: string[];
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const parts: string[] = [];
  if (names === undefined) parts.push('A plugin you have not approved will stop.');
  else if (names.length > 0) {
    parts.push(
      `${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} not been approved, and will stop until you approve ${names.length === 1 ? 'it' : 'them'}.`
    );
  } else parts.push('Every plugin that is running has been approved, so none will stop.');
  if (skillNames === undefined) parts.push('A skill you have not trusted will stop being used.');
  else if (skillNames.length > 0) {
    parts.push(
      `${skillNames.join(', ')} ${skillNames.length === 1 ? 'has' : 'have'} not been trusted, and will not be used until you trust ${skillNames.length === 1 ? 'it' : 'them'}.`
    );
  } else parts.push('Every skill is trusted, so all of them keep being used.');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Enforce what plugins and skills declare?"
      description={parts.join(' ')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Leave it off
          </Button>
          <Button variant="primary" busy={busy} onClick={onConfirm}>
            Turn on
          </Button>
        </>
      }
    />
  );
}

export function PluginList({
  plugins,
  busyId,
  onReview,
  onEnable,
  onDisable,
}: {
  plugins: PluginInfo[];
  busyId?: string | null;
  onReview: (p: PluginInfo) => void;
  onEnable: (p: PluginInfo) => void;
  onDisable: (p: PluginInfo) => void;
}) {
  if (plugins.length === 0) {
    return (
      <EmptyState icon={ShieldCheck} title="No plugins found">
        Put a plugin’s folder in OpenClerq’s modules folder and restart OpenClerq. It is found at
        the next start.
      </EmptyState>
    );
  }
  return (
    <ul className="settings-list plugin-list" aria-label="Plugins">
      {plugins.map((p) => (
        <PluginRow
          key={p.id}
          plugin={p}
          busy={busyId === p.id}
          onReview={() => onReview(p)}
          onEnable={() => onEnable(p)}
          onDisable={() => onDisable(p)}
        />
      ))}
    </ul>
  );
}

export function PluginsSection() {
  const client = useClient();
  const live = useLive();
  const toast = useToast();
  const list = useResource('plugins', () => client.plugins(), { on: ['modules'] });
  // What was opened for review, as it was then: the list may change under the dialog.
  const [reviewing, setReviewing] = useState<PluginInfo | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState(false);

  const plugins = list.data?.plugins ?? [];
  const enforce = list.data?.enforce ?? false;
  const current = reviewing;
  const changed = current
    ? changedSince(
        current,
        plugins.find((p) => p.id === current.id)
      )
    : false;

  const refresh = async () => {
    await list.reload();
    live.invalidate();
  };

  const act = async (p: PluginInfo, what: 'enable' | 'disable') => {
    setBusyId(p.id);
    try {
      await (what === 'enable' ? client.enablePlugin(p.id) : client.disablePlugin(p.id));
      await refresh();
    } catch (e) {
      toast({ message: `Couldn’t ${what} ${p.name}. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setBusyId(null);
    }
  };

  const approve = async () => {
    if (!current) return;
    setBusyId(current.id);
    setError(null);
    const out = await approveReviewed(client, current);
    setBusyId(null);
    if (out.ok) {
      setReviewing(null);
      toast({ message: `Approved ${current.name}.`, tone: 'ok' });
    } else {
      setError(out.message);
    }
    // After a refusal because it changed, the list shows what is there now.
    await refresh();
  };

  const setEnforce = async (on: boolean) => {
    setSwitching(true);
    try {
      await client.setPluginSettings({ enforce: on });
      setConfirming(false);
      await refresh();
    } catch (e) {
      toast({ message: `Couldn’t change it. ${errorMessage(e)}`, tone: 'err' });
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Section title="Plugins">
      <Loaded resource={list} what="plugins" skeleton="rows">
        {() => (
          <>
            <EnforceSwitch
              enforce={enforce}
              busy={switching}
              onChange={(on) => (on ? setConfirming(true) : void setEnforce(false))}
            />
            <PluginList
              plugins={plugins}
              busyId={busyId}
              onReview={(p) => {
                setError(null);
                setReviewing(p);
              }}
              onEnable={(p) => void act(p, 'enable')}
              onDisable={(p) => void act(p, 'disable')}
            />
          </>
        )}
      </Loaded>
      {current && (
        <ReviewDialog
          plugin={current}
          enforce={enforce}
          open
          busy={busyId === current.id}
          error={error}
          changed={changed}
          onClose={() => setReviewing(null)}
          onApprove={() => void approve()}
        />
      )}
      <EnforceDialog
        open={confirming}
        names={wouldStop(plugins)}
        busy={switching}
        onClose={() => setConfirming(false)}
        onConfirm={() => void setEnforce(true)}
      />
    </Section>
  );
}
