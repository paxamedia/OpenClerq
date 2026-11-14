/**
 * Settings → Skills: the skills OpenClerq found, whether you trust each, what each declares it
 * needs, and the switch that makes those declarations count.
 *
 * A skill is text that goes into a prompt. Trusting one records the exact files you looked at
 * (their checksum) and what they declared; if a file changes, the skill is "changed since you
 * trusted it" and needs a new decision. The switch is the same one Plugins has: off, trust is
 * shown and recorded and nothing is held back, except that a skill you blocked is never used.
 */

import { useEffect, useState } from 'react';
import { Ban, BookOpen, Check, Pencil, RotateCcw, Save } from 'lucide-react';
import {
  GatewayError,
  type SkillChanges,
  type SkillInfo,
  type SkillMeta,
  type SkillTrust,
} from '@clerq/gateway-client';
import { describeSkillNeeds } from '@clerq/plugin-sdk/skill';
import { Button } from '../../ui/Button';
import { CodeBlock, EmptyState } from '../../ui/Display';
import { Input, Textarea } from '../../ui/Field';
import { Dialog } from '../../ui/Modal';
import { StatusTag, type Tone } from '../../ui/Status';
import { Table } from '../../ui/Table';
import { useToast } from '../../ui/Toast';
import { useClient, type GatewayClient } from '../../app/client';
import { errorMessage } from '../../app/format';
import { useLive, useResource } from '../../app/live';
import { Loaded, Section } from '../../shell/layout';
import { EnforceDialog, EnforceSwitch, shortHash } from './plugins';
import { useSaver } from './sections';

export const TRUST_LABEL: Record<SkillTrust, string> = {
  untrusted: 'Not trusted',
  trusted: 'Trusted',
  modified: 'Changed',
  blocked: 'Blocked',
};

export function trustTone(trust: SkillTrust): Tone {
  return trust === 'trusted'
    ? 'ok'
    : trust === 'modified'
      ? 'warn'
      : trust === 'blocked'
        ? 'err'
        : 'muted';
}

/** Who vouches for a trusted skill, in words. */
export function trustedByWords(skill: Pick<SkillInfo, 'trustedBy' | 'origin'>): string | null {
  switch (skill.trustedBy) {
    case 'user':
      return 'You trusted it';
    case 'bundled':
      return 'Ships with OpenClerq';
    case 'plugin':
      return `Approved with its plugin (${skill.origin.replace(/^plugin:/, '')})`;
    default:
      return null;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a skill declares, in a few words for a list. */
export function declaresSummary(declared: SkillInfo['declared']): string {
  const parts = [
    declared.tools.length > 0 && plural(declared.tools.length, 'tool'),
    declared.domains.length > 0 && plural(declared.domains.length, 'host'),
    declared.paths.length > 0 && plural(declared.paths.length, 'path'),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Nothing';
}

/** Where a skill comes from, in words. */
export function originWords(origin: string): string {
  if (origin === 'directory') return 'Skills folder';
  if (origin.startsWith('plugin:')) return `Plugin ${origin.slice(7)}`;
  if (origin.startsWith('module:')) return `Module ${origin.slice(7)}`;
  return origin;
}

export type SkillAction = 'trust' | 'block' | 'untrust';

/**
 * The decisions a skill's dialog offers, in order. A plugin's skill is approved with its plugin, so
 * Trust is not offered for it; one whose files cannot be hashed cannot be trusted.
 */
export function skillActions(skill: SkillInfo): SkillAction[] {
  const fromPlugin = skill.origin.startsWith('plugin:');
  const canTrust = !fromPlugin && skill.computedChecksum !== null;
  switch (skill.trust) {
    case 'blocked':
      return ['untrust'];
    case 'trusted':
      return fromPlugin ? ['block'] : ['untrust', 'block'];
    case 'modified':
      return [...(canTrust ? (['trust'] as const) : []), 'untrust', 'block'];
    default:
      return [...(canTrust ? (['trust'] as const) : []), 'block'];
  }
}

/** The label of the button that forgets a decision: for a block it is an unblock. */
export const untrustLabel = (skill: Pick<SkillInfo, 'trust'>): string =>
  skill.trust === 'blocked' ? 'Unblock' : 'Untrust';

/** Names of the skills that would stop being used if enforcement were turned on now. */
export function wouldSkip(skills: SkillInfo[]): string[] {
  return skills.filter((s) => s.trust === 'untrusted' || s.trust === 'modified').map((s) => s.name);
}

const STALE = 'The skill changed after you looked at it. Nothing was trusted. Look at it again.';

/**
 * Trust exactly what was shown: the checksum the dialog's own read of the skill gave. A skill that
 * changed since answers 409, and the person is asked to look again.
 */
export async function trustReviewed(
  client: Pick<GatewayClient, 'trustSkill'>,
  skill: Pick<SkillInfo, 'slug' | 'computedChecksum'>
): Promise<{ ok: true } | { ok: false; stale: boolean; message: string }> {
  if (!skill.computedChecksum) {
    return {
      ok: false,
      stale: false,
      message: 'Its files could not be read, so it cannot be trusted.',
    };
  }
  try {
    await client.trustSkill(skill.slug, skill.computedChecksum);
    return { ok: true };
  } catch (e) {
    const stale = e instanceof GatewayError && e.status === 409 && e.body?.error === 'trust_stale';
    return { ok: false, stale, message: stale ? STALE : errorMessage(e) };
  }
}

// ---------------------------------------------------------------------------
// Review

/** What a skill declares, one need at a time, in plain words. */
export function SkillNeedsList({ skill }: { skill: SkillInfo }) {
  const lines = describeSkillNeeds(skill.declared);
  if (lines.length === 0) return <p className="page-hint">It declares no needs.</p>;
  return (
    <ul className="plugin-permissions" aria-label="What it declares">
      {lines.map((line) => (
        <li key={line.key}>
          <span className="plugin-permission-label">{line.label}</span>
          <span className="page-hint">{line.summary}</span>
          <ul className="plugin-permission-items">
            {line.items.map((item) => (
              <li key={item}>
                <code>{item}</code>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** What differs from the files you trusted: which files, what it now declares, the version. */
export function SkillWhatChanged({ skill }: { skill: SkillInfo }) {
  const changes: SkillChanges | null = skill.changes;
  if (skill.trust !== 'modified' && skill.trust !== 'blocked') return null;
  if (!changes) return null;
  const notes: string[] = [];
  if (changes.version) {
    notes.push(
      `The version went from ${changes.version.from ?? 'none'} to ${changes.version.to ?? 'none'}.`
    );
  }
  for (const f of changes.files.changed) notes.push(`${f} changed.`);
  for (const f of changes.files.added) notes.push(`${f} was added.`);
  for (const f of changes.files.removed) notes.push(`${f} was removed.`);
  if (notes.length === 0 && changes.needs.length === 0) return null;
  return (
    <div className="plugin-changes">
      <h3 className="settings-subtitle">
        {skill.trust === 'blocked'
          ? 'What changed since you blocked it'
          : 'What changed since you trusted it'}
      </h3>
      <ul aria-label="What changed">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
        {changes.needs.map((c) => (
          <li
            key={`${c.key}:${c.item}:${c.change}`}
            className={c.change === 'added' ? 'plugin-added' : undefined}
          >
            {c.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Its checksum, and whether it is the one its author wrote in SKILL.md. */
export function SkillChecksum({ skill }: { skill: SkillInfo }) {
  return (
    <p className="page-hint skill-checksum">
      {skill.computedChecksum ? (
        <>
          Checksum of its {plural(skill.files.length, 'file')}:{' '}
          <code>{shortHash(skill.computedChecksum.replace(/^sha256:/, ''))}</code>.{' '}
        </>
      ) : (
        <>Its files could not be hashed. </>
      )}
      {skill.checksum === null
        ? 'SKILL.md does not declare a checksum.'
        : skill.checksumMatches
          ? 'It matches the checksum in SKILL.md.'
          : skill.checksumMatches === false
            ? 'It does not match the checksum in SKILL.md, so the files are not what the author published.'
            : 'SKILL.md declares one, but it could not be compared.'}
    </p>
  );
}

/** Shown when the skill the dialog was opened on is not the one the list shows now. */
export const SKILL_CHANGED_NOTE =
  'This skill changed while you were looking at it. Close this and look at it again: nothing shown here can be trusted.';

export function SkillDialog({
  skill,
  body,
  enforce,
  open,
  busy,
  error,
  changed,
  onClose,
  onAction,
  onSchemas,
}: {
  skill: SkillInfo;
  /** Its instructions, from the same read as `skill`; null while they load. */
  body: string | null;
  enforce: boolean;
  open: boolean;
  busy?: boolean;
  error?: string | null;
  /** The list now shows something else than what this dialog was opened on. */
  changed?: boolean;
  onClose: () => void;
  onAction: (action: SkillAction) => void;
  onSchemas?: () => void;
}) {
  const actions = skillActions(skill);
  const by = trustedByWords(skill);
  const notTrusted = skill.trust === 'untrusted' || skill.trust === 'modified';
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={skill.name}
      description={skill.description}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {onSchemas && (
            <Button variant="ghost" icon={Pencil} onClick={onSchemas}>
              Schemas
            </Button>
          )}
          {actions.includes('block') && (
            <Button variant="danger" icon={Ban} busy={busy} onClick={() => onAction('block')}>
              Block
            </Button>
          )}
          {actions.includes('untrust') && (
            <Button icon={RotateCcw} busy={busy} onClick={() => onAction('untrust')}>
              {untrustLabel(skill)}
            </Button>
          )}
          {actions.includes('trust') && (
            <Button
              variant="primary"
              icon={Check}
              busy={busy}
              disabled={changed || body === null}
              onClick={() => onAction('trust')}
            >
              Trust
            </Button>
          )}
        </>
      }
    >
      <div className="plugin-review">
        <p>
          <StatusTag tone={trustTone(skill.trust)}>{TRUST_LABEL[skill.trust]}</StatusTag>{' '}
          {skill.trustReason}
          {by && skill.trust === 'trusted' && ` ${by}.`}
        </p>
        <SkillWhatChanged skill={skill} />
        <h3 className="settings-subtitle">What it declares</h3>
        <SkillNeedsList skill={skill} />
        {skill.warnings.length > 0 && (
          <ul className="plugin-warnings" aria-label="Warnings">
            {skill.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {skill.problem && (
          <p className="tone-text-err" role="alert">
            {skill.problem}
          </p>
        )}
        <SkillChecksum skill={skill} />
        {body !== null && <CodeBlock title="Instructions" code={body} wrap maxHeight="md" />}
        {actions.includes('trust') && (
          <p className="page-hint">
            Trusting records exactly these files (checksum{' '}
            <code>{shortHash(skill.computedChecksum?.replace(/^sha256:/, '') ?? null)}</code>) and
            what they declare. If any file changes, you will be asked again.{' '}
            {enforce
              ? 'Enforcement is on: the skill is not used until you trust it.'
              : 'Enforcement is off, so the skill is used whether or not you trust it. The decision is recorded, and counts if you turn enforcement on.'}
          </p>
        )}
        {skill.origin.startsWith('plugin:') && (
          <p className="page-hint">
            This skill comes with a plugin and is approved with it, in Settings → Plugins. You can
            still block it.
          </p>
        )}
        {notTrusted && enforce && !actions.includes('trust') && (
          <p className="page-hint">
            It cannot be trusted as it is, so it is not used while enforcement is on.
          </p>
        )}
        {changed && (
          <p className="tone-text-err" role="alert">
            {SKILL_CHANGED_NOTE}
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
// Schemas and dependencies (as before)

function SkillEditor({
  slug,
  all,
  onClose,
}: {
  slug: string;
  all: SkillMeta[];
  onClose: () => void;
}) {
  const client = useClient();
  const detail = useResource(`skill:${slug}`, () => client.skill(slug));
  const { save, busy } = useSaver();
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [deps, setDeps] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const m = detail.data?.meta;
    if (!m) return;
    setInput(m.inputSchema ? JSON.stringify(m.inputSchema, null, 2) : '');
    setOutput(m.outputSchema ? JSON.stringify(m.outputSchema, null, 2) : '');
    setDeps(m.dependsOn?.join(', ') ?? '');
  }, [detail.data]);

  const parse = (text: string, which: string): Record<string, unknown> | null | undefined => {
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      setProblem(`The ${which} schema isn’t valid JSON.`);
      return undefined;
    }
  };

  const submit = async () => {
    setProblem(null);
    const inputSchema = parse(input, 'input');
    const outputSchema = parse(output, 'output');
    if (inputSchema === undefined || outputSchema === undefined) return;
    const list = deps
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    await save(slug, () =>
      client.updateSkill(slug, { inputSchema, outputSchema, dependsOn: list.length ? list : null })
    );
    await detail.reload();
  };

  const unknown = deps
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !all.some((k) => k.slug === s));

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Schemas · ${detail.data?.meta.name ?? slug}`}
      size="lg"
      description="Saving rewrites SKILL.md, so a skill you trusted needs to be trusted again."
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" icon={Save} busy={busy} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <Loaded resource={detail} what="the skill" skeleton="text">
        {() => (
          <div className="settings-form">
            <Textarea
              label="Input schema"
              mono
              rows={6}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              hint="JSON Schema. Leave empty for none."
            />
            <Textarea
              label="Output schema"
              mono
              rows={6}
              value={output}
              onChange={(e) => setOutput(e.target.value)}
            />
            <Input
              label="Depends on"
              value={deps}
              onChange={(e) => setDeps(e.target.value)}
              placeholder="vat-core, payroll-base"
              hint={unknown.length ? undefined : 'Other skills, by slug, separated by commas.'}
              error={
                unknown.length ? `Not a skill here: ${unknown.join(', ')}.` : (problem ?? undefined)
              }
            />
          </div>
        )}
      </Loaded>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The list

export function SkillsTable({
  skills,
  onOpen,
}: {
  skills: SkillInfo[];
  onOpen: (skill: SkillInfo) => void;
}) {
  return (
    <Table
      label="Skills"
      rows={skills}
      rowKey={(s) => s.slug}
      onRowClick={onOpen}
      columns={[
        {
          key: 'name',
          header: 'Skill',
          cell: (s) => (
            <span className="skill-name">
              {s.name}
              <span className="page-hint">{originWords(s.origin)}</span>
            </span>
          ),
          sortValue: (s) => s.name,
        },
        {
          key: 'trust',
          header: 'Trust',
          cell: (s) => <StatusTag tone={trustTone(s.trust)}>{TRUST_LABEL[s.trust]}</StatusTag>,
          sortValue: (s) => TRUST_LABEL[s.trust],
          width: 'sm',
        },
        {
          key: 'declares',
          header: 'Declares',
          cell: (s) => <span className="page-muted">{declaresSummary(s.declared)}</span>,
        },
        {
          key: 'version',
          header: 'Version',
          cell: (s) => s.version ?? '',
          mono: true,
          width: 'sm',
        },
      ]}
      empty={
        <EmptyState icon={BookOpen} title="No skills here">
          Add skill folders to the skills directory under Advanced.
        </EmptyState>
      }
    />
  );
}

/** A skill the dialog was opened on is the one the list still shows, with the same files. */
export function skillChangedSince(
  opened: Pick<SkillInfo, 'computedChecksum' | 'trust'>,
  now: Pick<SkillInfo, 'computedChecksum' | 'trust'> | undefined
): boolean {
  return !now || now.computedChecksum !== opened.computedChecksum;
}

function SkillReview({
  slug,
  enforce,
  all,
  onClose,
  onDecided,
}: {
  slug: string;
  enforce: boolean;
  all: SkillInfo[];
  onClose: () => void;
  onDecided: () => Promise<void>;
}) {
  const client = useClient();
  const toast = useToast();
  const detail = useResource(`skill:${slug}`, () => client.skill(slug));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schemas, setSchemas] = useState(false);
  // What was on screen when the dialog opened: what Trust names.
  const opened = detail.data?.skill;
  const listed = all.find((s) => s.slug === slug);
  const changed = opened ? skillChangedSince(opened, listed) : false;

  const decide = async (action: SkillAction) => {
    if (!opened) return;
    setBusy(true);
    setError(null);
    let failure: string | null = null;
    if (action === 'trust') {
      const out = await trustReviewed(client, opened);
      if (!out.ok) failure = out.message;
      else toast({ message: `Trusted ${opened.name}.`, tone: 'ok' });
    } else {
      try {
        await (action === 'block' ? client.blockSkill(slug) : client.untrustSkill(slug));
      } catch (e) {
        failure = errorMessage(e);
      }
    }
    setBusy(false);
    setError(failure);
    // After a refusal because it changed, the dialog and the list show what is there now.
    await detail.reload();
    await onDecided();
  };

  if (!opened) {
    return (
      <Dialog
        open
        onClose={onClose}
        title={listed?.name ?? slug}
        actions={
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        }
      >
        <Loaded resource={detail} what="the skill" skeleton="text">
          {() => null}
        </Loaded>
      </Dialog>
    );
  }
  return (
    <>
      <SkillDialog
        skill={opened}
        body={detail.data?.body ?? null}
        enforce={enforce}
        open
        busy={busy}
        error={error}
        changed={changed}
        onClose={onClose}
        onAction={(a) => void decide(a)}
        onSchemas={opened.origin === 'directory' ? () => setSchemas(true) : undefined}
      />
      {schemas && (
        <SkillEditor
          slug={slug}
          all={all}
          onClose={() => {
            setSchemas(false);
            void detail.reload().then(onDecided);
          }}
        />
      )}
    </>
  );
}

export function SkillsSection() {
  const client = useClient();
  const live = useLive();
  const toast = useToast();
  const skills = useResource('skills', () => client.skills());
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState(false);

  const enforce = skills.data?.enforce ?? false;
  const refresh = async () => {
    await skills.reload();
    live.invalidate();
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
    <Section title="Skills">
      <Loaded resource={skills} what="skills" skeleton="rows">
        {(d) => (
          <>
            <EnforceSwitch
              enforce={enforce}
              busy={switching}
              onChange={(on) => (on ? setConfirming(true) : void setEnforce(false))}
            />
            <p className="page-hint">
              From <code>{d.source}</code>. Click a skill to see what it declares, its instructions
              and its checksum, and to trust or block it.
            </p>
            <SkillsTable skills={d.skills} onOpen={(s) => setOpen(s.slug)} />
          </>
        )}
      </Loaded>
      {open && (
        <SkillReview
          slug={open}
          enforce={enforce}
          all={skills.data?.skills ?? []}
          onClose={() => setOpen(null)}
          onDecided={refresh}
        />
      )}
      <EnforceDialog
        open={confirming}
        skillNames={wouldSkip(skills.data?.skills ?? [])}
        busy={switching}
        onClose={() => setConfirming(false)}
        onConfirm={() => void setEnforce(true)}
      />
    </Section>
  );
}
