/**
 * A gateway client over made-up data, for screenshots, tests and working on
 * the screens without a gateway. Actions change the data in memory.
 *
 * `createFixtureClient({ now })` fixes the clock so screenshots are stable.
 */

import type {
  Approval,
  ArtifactInfo,
  AutomationSummary,
  ChatDraft,
  ChatMessage,
  ChatSession,
  MemoryRecord,
  MemoryType,
  ProviderInfo,
  RepoDetail,
  RepoSummary,
  RunDetail,
  RunStep,
  RunSummary,
} from '@clerq/gateway-client';
import type { GatewayClient } from '../app/client';
import { nextFirings } from '../app/cron';

const H = 3_600_000;
const D = 24 * H;

/** A seeded random number, so the same fixture draws the same picture every time. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const DIFF = `diff --git a/package.json b/package.json
index 3b18e51..a9c2f0d 100644
--- a/package.json
+++ b/package.json
@@ -12,9 +12,9 @@
   "dependencies": {
-    "express": "^5.1.0",
-    "zod": "^3.24.1",
+    "express": "^5.2.1",
+    "zod": "^3.25.4",
     "pino": "^9.6.0"
   },
   "devDependencies": {
-    "vitest": "^4.0.2"
+    "vitest": "^4.0.9"
   }
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 77ac0e1..c1d0b42 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,6 +1,6 @@
 lockfileVersion: '9.0'
-  express: 5.1.0
+  express: 5.2.1
   pino: 9.6.0
-  zod: 3.24.1
+  zod: 3.25.4
`;

const SPEC = (name: string, schedule: string, repo: string, cap: number) => `name: ${name}
description: Patch and minor dependency updates, as a draft PR
on:
  schedule: '${schedule}'
targets:
  repos: [local:${repo}]
agent:
  driver: claude-code
prompt: |
  Update dependencies with patch and minor releases only.
gates:
  - run: pnpm install --frozen-lockfile
  - run: pnpm test
publish:
  pull_request: draft
budget:
  max_usd_per_run: 2
  max_usd_per_month: ${cap}
approvals:
  push: manual
`;

export interface FixtureOptions {
  /** The fixture's "now", in ms. Default: the real clock. */
  now?: number;
  /** No data at all, to show the empty states. */
  empty?: boolean;
  /** Every read fails, to show the error states. */
  offline?: boolean;
}

export function createFixtureClient(opts: FixtureOptions = {}): GatewayClient {
  const now = opts.now ?? Date.now();
  const iso = (t: number) => new Date(t).toISOString();
  const random = rng(7);

  const automations: Array<
    AutomationSummary & { source: string; monthBudgetUsd: number | null; nextFirings: string[] }
  > = opts.empty
    ? []
    : [
        {
          id: 'aut_deps',
          name: 'weekly-deps',
          description: 'Patch and minor dependency updates',
          schedule: '0 8 * * 1',
          repo: '~/code/shop',
          cap: 20,
          enabled: true,
        },
        {
          id: 'aut_docs',
          name: 'docs-links',
          description: 'Fix broken links in the docs',
          schedule: '30 6 * * 1-5',
          repo: '~/code/site',
          cap: 10,
          enabled: true,
        },
        {
          id: 'aut_tests',
          name: 'flaky-tests',
          description: 'Find and quarantine flaky tests',
          schedule: '0 22 * * *',
          repo: '~/code/api',
          cap: 30,
          enabled: true,
        },
        {
          id: 'aut_licence',
          name: 'licence-headers',
          description: 'Add missing licence headers',
          schedule: '0 9 1 * *',
          repo: '~/code/kit',
          cap: 5,
          enabled: false,
        },
        {
          id: 'aut_widgets',
          name: 'widgets-bumps',
          description: 'Dependency updates for example/widgets',
          schedule: '0 7 * * 2',
          repo: 'github:example/widgets',
          cap: 10,
          enabled: true,
        },
        {
          id: 'aut_widgets_docs',
          name: 'widgets-docs',
          description: 'Keep the widgets docs current',
          schedule: '0 7 * * 4',
          repo: 'github:example/widgets',
          cap: 5,
          enabled: false,
        },
        {
          id: 'aut_tools',
          name: 'tools-lint',
          description: 'Lint lab/tools',
          schedule: '0 5 * * 1-5',
          repo: 'gitlab:lab/tools',
          cap: 5,
          enabled: true,
        },
      ].map((a) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        enabled: a.enabled,
        schedule: a.schedule,
        nextRunAt: a.enabled
          ? (nextFirings(a.schedule, 1, new Date(now))[0]?.toISOString() ?? null)
          : null,
        nextFirings: nextFirings(a.schedule, 10, new Date(now)).map((d) => d.toISOString()),
        driver: 'claude-code',
        repo: a.repo,
        problem: null,
        running: a.id === 'aut_tests',
        queued: a.id === 'aut_tests',
        catchUp: a.id === 'aut_deps',
        missedSlots:
          a.id === 'aut_docs'
            ? {
                count: 2,
                capped: false,
                first: iso(now - 2 * D - 4 * H),
                last: iso(now - D - 4 * H),
                reason: 'catch_up_off' as const,
                noticed: 'wake',
                at: iso(now - 10 * H),
              }
            : null,
        authoredBy: a.id === 'aut_licence' ? 'chat ses_3' : null,
        monthSpendUsd: 0,
        monthBudgetUsd: a.cap,
        lastRun: null,
        updatedAt: iso(now - 9 * D),
        source: SPEC(a.name, a.schedule, a.repo, a.cap),
      }));

  // Runs over the last 14 days.
  const runs: RunDetail[] = [];
  if (!opts.empty) {
    let n = 0;
    for (let day = 13; day >= 0; day--) {
      const perDay = 2 + Math.floor(random() * 5);
      for (let k = 0; k < perDay; k++) {
        const created = now - day * D - Math.floor(random() * 20 * H) - H;
        if (created > now - 20 * 60_000) continue;
        const a = automations[Math.floor(random() * 3)];
        const chat = random() < 0.25;
        const failed = random() < 0.12;
        const ms = (chat ? 2 : 4 + random() * 18) * 60_000;
        const cost = chat ? 0.002 + random() * 0.02 : 0.15 + random() * 1.4;
        n++;
        runs.push({
          id: `run_${(100000 + n).toString(36)}${Math.floor(random() * 1e6).toString(36)}`,
          status: failed ? 'failed' : 'done',
          trigger: chat ? 'manual' : random() < 0.8 ? 'schedule' : 'manual',
          automationId: chat ? undefined : a.id,
          automationName: chat ? undefined : a.name,
          input: chat ? 'Summarise the open pull requests' : undefined,
          exitReason: failed
            ? 'Gate failed: pnpm test'
            : chat
              ? undefined
              : 'Published: draft pull request',
          createdAt: iso(created),
          startedAt: iso(created + 2000),
          finishedAt: iso(created + ms),
          costUsd: Math.round(cost * 10000) / 10000,
          costKnown: true,
          tokensIn: Math.floor(cost * 400000),
          tokensOut: Math.floor(cost * 60000),
          branch: chat ? undefined : `clerq/${a.name}-${n}`,
          prUrl: chat || failed ? undefined : `https://github.com/example/shop/pull/${200 + n}`,
          steps: [],
          artifacts: [],
        });
      }
    }
    // One running now and one waiting for approval.
    runs.push({
      id: 'run_live01',
      status: 'executing',
      trigger: 'schedule',
      automationId: 'aut_tests',
      automationName: 'flaky-tests',
      createdAt: iso(now - 7 * 60_000),
      startedAt: iso(now - 7 * 60_000),
      costUsd: 0.31,
      costKnown: true,
      tokensIn: 120400,
      tokensOut: 8200,
      branch: 'clerq/flaky-tests-live',
      steps: [],
      artifacts: [],
    });
    runs.push({
      id: 'run_wait01',
      status: 'awaiting_approval',
      trigger: 'schedule',
      automationId: 'aut_deps',
      automationName: 'weekly-deps',
      createdAt: iso(now - 40 * 60_000),
      startedAt: iso(now - 40 * 60_000),
      costUsd: 0.84,
      costKnown: true,
      tokensIn: 310200,
      tokensOut: 22100,
      branch: 'clerq/weekly-deps-118',
      steps: [],
      artifacts: [],
    });
    runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (const r of runs) {
      if (!r.automationId) continue;
      r.steps = stepsFor(r);
      if (
        r.steps.some(
          (s) => s.kind === 'git' && (s.input as { action?: string }).action === 'commit'
        )
      ) {
        r.artifacts = [
          {
            id: 1,
            kind: 'diff',
            name: `${r.branch}.diff`,
            size: DIFF.length,
            sha256: 'f'.repeat(64),
          } as ArtifactInfo,
        ];
      }
    }
    runs.push(...specialRuns());
    runs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const month = new Date(now);
    const monthStart = new Date(month.getFullYear(), month.getMonth(), 1).getTime();
    for (const a of automations) {
      const mine = runs.filter((r) => r.automationId === a.id);
      a.monthSpendUsd =
        Math.round(
          mine
            .filter((r) => Date.parse(r.createdAt) >= monthStart)
            .reduce((s, r) => s + r.costUsd, 0) * 100
        ) / 100;
      const last = mine[0];
      a.lastRun = last
        ? {
            id: last.id,
            status: last.status,
            exitReason: last.exitReason,
            prUrl: last.prUrl,
            createdAt: last.createdAt,
          }
        : null;
    }
  }

  function stepsFor(r: RunDetail): RunStep[] {
    const t0 = Date.parse(r.startedAt ?? r.createdAt);
    const end = r.finishedAt ? Date.parse(r.finishedAt) : now;
    const span = Math.max(60_000, end - t0);
    const at = (f: number) => iso(t0 + span * f);
    const steps: RunStep[] = [
      {
        seq: 1,
        kind: 'git',
        input: { action: 'fetch', ref: 'main' },
        output: { startRef: 'origin/main' },
        status: 'ok',
        durationMs: 1400,
        createdAt: at(0.02),
      },
      {
        seq: 2,
        kind: 'git',
        input: { action: 'worktree', repo: '~/code/shop' },
        output: { branch: r.branch },
        status: 'ok',
        durationMs: 900,
        createdAt: at(0.04),
      },
      {
        seq: 3,
        kind: 'llm',
        output: { text: 'Reading package.json and the lockfile.' },
        status: 'text',
        createdAt: at(0.1),
      },
      {
        seq: 4,
        kind: 'tool',
        input: { name: 'Bash', command: 'pnpm outdated' },
        status: 'ok',
        durationMs: span * 0.12,
        createdAt: at(0.25),
      },
      {
        seq: 5,
        kind: 'tool',
        input: { name: 'Edit', file: 'package.json' },
        status: 'ok',
        durationMs: span * 0.05,
        createdAt: at(0.35),
      },
    ];
    if (r.status === 'executing')
      return steps
        .slice(0, 4)
        .map((s, i) => (i === 3 ? { ...s, status: 'running', durationMs: undefined } : s));
    steps.push(
      {
        seq: 6,
        kind: 'llm',
        status: 'done',
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        costUsd: r.costUsd,
        durationMs: span * 0.45,
        createdAt: at(0.55),
      },
      {
        seq: 7,
        kind: 'git',
        input: { action: 'commit' },
        output: {
          sha: '9f3c2e18b',
          filesChanged: 2,
          insertions: 5,
          deletions: 5,
          files: ['package.json', 'pnpm-lock.yaml'],
        },
        status: 'ok',
        durationMs: 600,
        createdAt: at(0.57),
      },
      {
        seq: 8,
        kind: 'gate',
        input: { run: 'pnpm install --frozen-lockfile' },
        status: 'passed',
        durationMs: span * 0.1,
        createdAt: at(0.68),
      },
      {
        seq: 9,
        kind: 'gate',
        input: { run: 'pnpm test' },
        status: r.status === 'failed' ? 'failed' : 'passed',
        durationMs: span * 0.22,
        createdAt: at(0.92),
      }
    );
    if (r.status === 'done') {
      steps.push(
        {
          seq: 10,
          kind: 'git',
          input: { action: 'push', branch: r.branch },
          status: 'ok',
          durationMs: 2100,
          createdAt: at(0.96),
        },
        {
          seq: 11,
          kind: 'git',
          input: { action: 'pull_request' },
          output: { url: r.prUrl },
          status: 'ok',
          durationMs: 1300,
          createdAt: at(0.99),
        }
      );
    }
    return steps;
  }

  /**
   * Runs that show what the run page can say: every labelled step, tool calls
   * with their decisions, and a run with sub-agents under it.
   */
  function specialRuns(): RunDetail[] {
    const diffArtifact = [
      {
        id: 1,
        kind: 'diff',
        name: 'clerq-weekly-deps.diff',
        size: DIFF.length,
        sha256: 'f'.repeat(64),
      },
    ] as ArtifactInfo[];
    const t0 = now - 5 * H;
    const at = (min: number) => iso(t0 + min * 60_000);
    const rich: RunDetail = {
      id: 'run_rich01',
      status: 'done',
      trigger: 'schedule',
      automationId: 'aut_deps',
      automationName: 'weekly-deps',
      modelOverride: 'anthropic/claude-haiku-5-5',
      exitReason: 'Published: draft pull request',
      createdAt: at(0),
      startedAt: at(1),
      finishedAt: at(31),
      costUsd: 1.12,
      costKnown: true,
      tokensIn: 402_000,
      tokensOut: 31_400,
      branch: 'clerq/weekly-deps-rich',
      prUrl: 'https://github.com/example/widgets/pull/412',
      artifacts: diffArtifact,
      steps: [
        {
          seq: 1,
          kind: 'tool',
          input: { name: 'schedule.catch_up' },
          output: {
            missedSlots: 2,
            countCapped: false,
            firstMissed: at(-2 * 24 * 60),
            slot: at(-24 * 60),
            noticed: 'wake',
          },
          status: 'ok',
          createdAt: at(0),
        },
        {
          seq: 2,
          kind: 'tool',
          input: { name: 'run.requeue', relaunch: 1 },
          output: { after: 'Its gateway stopped before it could start.', of: 3 },
          status: 'warning',
          createdAt: at(0.5),
        },
        {
          seq: 3,
          kind: 'git',
          input: { action: 'clone', repo: 'github:example/widgets' },
          output: {
            path: '/Users/me/.clerq/workspaces/widgets-3f9a1c2b7d10',
            url: 'https://github.com/example/widgets.git',
            credential: 'vault:GITHUB_TOKEN',
          },
          status: 'ok',
          durationMs: 8200,
          createdAt: at(1.4),
        },
        {
          seq: 4,
          kind: 'git',
          input: { action: 'fetch', ref: 'main' },
          output: { startRef: 'origin/main' },
          status: 'ok',
          durationMs: 1100,
          createdAt: at(1.5),
        },
        {
          seq: 5,
          kind: 'git',
          input: { action: 'worktree', repo: '/Users/me/.clerq/workspaces/widgets-3f9a1c2b7d10' },
          output: { branch: 'clerq/weekly-deps-rich' },
          status: 'ok',
          durationMs: 700,
          createdAt: at(1.6),
        },
        {
          seq: 6,
          kind: 'tool',
          input: {
            name: 'driver.detect',
            driver: 'builtin',
            model: 'anthropic/claude-haiku-5-5',
            for: 'chosen',
          },
          output: { id: 'builtin', available: true },
          status: 'ok',
          createdAt: at(1.7),
        },
        {
          seq: 7,
          kind: 'tool',
          input: { name: 'sandbox', profile: 'native' },
          output: {
            note: 'Unisolated: the agent and the gates run with your account’s access to files and the network (profile native, the default). Set sandbox.profile to seatbelt or container to limit them.',
          },
          status: 'warning',
          createdAt: at(1.8),
        },
        {
          seq: 8,
          kind: 'tool',
          input: { name: 'memory.read', types: ['preference', 'procedure'] },
          output: { notes: 3 },
          status: 'ok',
          createdAt: at(1.9),
        },
        {
          seq: 9,
          kind: 'tool',
          input: {
            name: 'model.fallback',
            from: 'anthropic/claude-haiku-5-5',
            to: 'openai/gpt-5-mini',
          },
          output: { reason: 'Provider overloaded (HTTP 529).' },
          status: 'warning',
          createdAt: at(6),
        },
        {
          seq: 10,
          kind: 'tool',
          input: { name: 'context.compact', method: 'summary' },
          output: {
            compactedMessages: 24,
            keptMessages: 6,
            tokensBefore: 118_000,
            tokensAfter: 21_000,
          },
          status: 'ok',
          createdAt: at(11),
        },
        {
          seq: 11,
          kind: 'gate',
          input: { run: 'pnpm test' },
          output: {
            exitCode: 1,
            timedOut: false,
            stdout: '',
            stderr: 'Error: getaddrinfo ENOTFOUND registry.npmjs.org',
            egressDenied: [
              { host: 'registry.npmjs.org', port: 443, at: at(14) },
              { host: 'registry.npmjs.org', port: 443, at: at(14.1) },
            ],
          },
          status: 'failed',
          durationMs: 22_000,
          createdAt: at(14.3),
        },
        {
          seq: 12,
          kind: 'tool',
          input: { name: 'agent.escalate', escalation: 1, model: 'anthropic/claude-opus-5-5' },
          output: { from: 'openai/gpt-5-mini', after: 'Gate failed: pnpm test (exit 1)' },
          status: 'warning',
          createdAt: at(14.5),
        },
        {
          seq: 13,
          kind: 'tool',
          input: { name: 'run.retry', attempt: 2 },
          output: {
            after: 'The agent stopped without a result.',
            cause: 'driver_crash',
            notBefore: at(16),
          },
          status: 'warning',
          createdAt: at(15),
        },
        {
          seq: 14,
          kind: 'git',
          input: { action: 'commit' },
          output: { sha: '4be71d09c', filesChanged: 2, insertions: 5, deletions: 5 },
          status: 'ok',
          durationMs: 600,
          createdAt: at(24),
        },
        {
          seq: 15,
          kind: 'gate',
          input: { run: 'pnpm test' },
          output: { exitCode: 0, timedOut: false, stdout: '12 passed', stderr: '' },
          status: 'passed',
          durationMs: 31_000,
          createdAt: at(26),
        },
        {
          seq: 16,
          kind: 'tool',
          input: { name: 'diff.secrets' },
          output: {
            note: 'The diff contains a value from the vault that this run uses (redacted in the stored diff, not in the commit). Pushing waits for approval.',
          },
          status: 'warning',
          createdAt: at(26.5),
        },
        {
          seq: 17,
          kind: 'git',
          input: { action: 'push', branch: 'clerq/weekly-deps-rich' },
          output: { remote: 'https://github.com/example/widgets.git' },
          status: 'ok',
          durationMs: 2100,
          createdAt: at(30),
        },
        {
          seq: 18,
          kind: 'git',
          input: { action: 'pull_request' },
          output: { url: 'https://github.com/example/widgets/pull/412' },
          status: 'ok',
          durationMs: 1300,
          createdAt: at(31),
        },
      ],
      toolCalls: [
        {
          id: 1,
          name: 'fs.read',
          input: { path: 'package.json' },
          output: '{\n  "name": "widgets",\n  "dependencies": { "express": "^5.1.0" }\n}',
          status: 'ok',
          durationMs: 12,
          approvalState: 'not_required',
          createdAt: at(3),
        },
        {
          id: 2,
          name: 'runtime.shell',
          input: { command: 'pnpm outdated' },
          output: Array.from(
            { length: 24 },
            (_, i) => `package-${i + 1}   ^1.${i}.0   ^1.${i + 2}.0`
          ).join('\n'),
          status: 'ok',
          durationMs: 4300,
          approvalState: 'approved',
          createdAt: at(4),
        },
        {
          id: 3,
          name: 'fs.edit',
          input: { path: 'package.json', old: '^5.1.0', new: '^5.2.1' },
          output: 'Edited package.json (1 replacement).',
          status: 'ok',
          durationMs: 8,
          approvalState: 'not_required',
          createdAt: at(8),
        },
        {
          id: 4,
          name: 'runtime.shell',
          input: { command: 'git push origin HEAD' },
          output: 'You denied this request.',
          status: 'denied',
          durationMs: 61_000,
          approvalState: 'denied',
          createdAt: at(9),
        },
        {
          id: 5,
          name: 'Bash',
          input: { command: 'pnpm install --frozen-lockfile' },
          output: 'Done in 3.2s',
          status: 'ok',
          durationMs: 3300,
          approvalState: null,
          createdAt: at(12),
        },
        {
          id: 6,
          name: 'fs.write',
          input: { path: '/etc/hosts', content: '…' },
          output: 'The path is outside the worktree.',
          status: 'denied',
          durationMs: 3,
          approvalState: 'not_required',
          createdAt: at(13),
        },
      ],
    };

    const parentAt = now - 26 * 60_000;
    const child = (
      id: string,
      status: string,
      task: string,
      cost: number,
      start: number,
      minutes: number
    ): RunDetail => ({
      id,
      status,
      trigger: 'subagent',
      parentRunId: 'run_subs01',
      input: task,
      exitReason: status === 'failed' ? 'The sub-agent ran out of time.' : undefined,
      createdAt: iso(parentAt + start * 60_000),
      startedAt: iso(parentAt + start * 60_000),
      finishedAt: status === 'executing' ? undefined : iso(parentAt + (start + minutes) * 60_000),
      costUsd: cost,
      costKnown: true,
      tokensIn: Math.round(cost * 300_000),
      tokensOut: Math.round(cost * 40_000),
      steps: [
        {
          seq: 1,
          kind: 'tool',
          input: {
            name: 'subagent.start',
            parentRunId: 'run_subs01',
            tools: 'read-only',
            model: null,
            strict: false,
          },
          output: { allow: ['risk:read'], approvalRequired: [], deny: ['sessions.spawn'] },
          status: 'ok',
          createdAt: iso(parentAt + start * 60_000),
        },
        {
          seq: 2,
          kind: 'llm',
          output: { text: `Working on: ${task}` },
          status: 'text',
          createdAt: iso(parentAt + (start + 0.5) * 60_000),
        },
      ],
      artifacts: [],
    });
    const children = [
      child('run_subs_a', 'done', 'Find every use of the deprecated zod API in src/', 0.18, 2, 4),
      child('run_subs_b', 'done', 'List the tests that touch the checkout flow', 0.07, 2.5, 3),
      child(
        'run_subs_c',
        'executing',
        'Check the lockfile for duplicate express versions',
        0.04,
        8,
        5
      ),
    ];
    const subs: RunDetail = {
      id: 'run_subs01',
      status: 'executing',
      trigger: 'schedule',
      automationId: 'aut_tests',
      automationName: 'flaky-tests',
      createdAt: iso(parentAt),
      startedAt: iso(parentAt),
      costUsd: 0.62,
      costKnown: true,
      childCostUsd: 0.29,
      tokensIn: 210_000,
      tokensOut: 16_000,
      branch: 'clerq/flaky-tests-subs',
      steps: [
        {
          seq: 1,
          kind: 'tool',
          input: { name: 'sessions.spawn' },
          output: { text: 'Started 3 sub-agents.' },
          status: 'ok',
          durationMs: 240_000,
          createdAt: iso(parentAt + 6 * 60_000),
        },
      ],
      artifacts: [],
      children: children.map((c) => ({
        id: c.id,
        status: c.status,
        input: c.input,
        exitReason: c.exitReason,
        costUsd: c.costUsd,
        costKnown: true,
        createdAt: c.createdAt,
        finishedAt: c.finishedAt,
      })),
      toolCalls: [
        {
          id: 1,
          name: 'fs.search',
          input: { pattern: 'flaky', path: 'src' },
          output: 'src/checkout.test.ts:41: // flaky on CI',
          status: 'ok',
          durationMs: 30,
          approvalState: 'not_required',
          createdAt: iso(parentAt + 60_000),
        },
        {
          id: 2,
          name: 'sessions.spawn',
          input: { task: children[0].input, tools: ['risk:read'] },
          output: 'The sub-agent finished: 4 uses found.',
          status: 'ok',
          durationMs: 240_000,
          approvalState: 'not_required',
          createdAt: iso(parentAt + 2 * 60_000),
        },
      ],
    };
    // A sub-agent's rolled-up cost is on the parent's list entry too.
    return [rich, subs, ...children];
  }

  // Repositories: one per automation's folder, then a clone of a GitHub one and a GitLab one.
  const repoRows: RepoSummary[] = [];
  if (!opts.empty) {
    const folders: Record<string, { path: string; exists: boolean }> = {
      aut_deps: { path: '/Users/me/code/shop', exists: true },
      aut_docs: { path: '/Users/me/code/site', exists: true },
      aut_tests: { path: '/Users/me/code/api', exists: true },
      aut_licence: { path: '/Users/me/code/kit', exists: false },
    };
    const lastOf = (ids: string[]): RepoSummary['lastRun'] => {
      const r = runs.find((x) => x.automationId && ids.includes(x.automationId));
      return r
        ? {
            id: r.id,
            status: r.status,
            createdAt: r.createdAt,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
          }
        : null;
    };
    const countOf = (ids: string[]): RepoSummary['runs'] => ({
      queued: runs.filter(
        (x) => x.automationId && ids.includes(x.automationId) && x.status === 'queued'
      ).length,
      running: runs.filter(
        (x) =>
          x.automationId &&
          ids.includes(x.automationId) &&
          ['preparing', 'executing', 'verifying', 'publishing', 'awaiting_approval'].includes(
            x.status
          )
      ).length,
    });
    for (const [autId, f] of Object.entries(folders)) {
      const a = automations.find((x) => x.id === autId);
      if (!a) continue;
      repoRows.push({
        id: `repo_${autId.slice(4)}`,
        kind: 'local',
        name: f.path.split('/').pop() as string,
        url: null,
        path: { value: f.path, exists: f.exists, role: 'repository' },
        credential: null,
        automations: [
          {
            id: a.id,
            name: a.name,
            enabled: a.enabled,
            // Pushing needs a token; the one in the licence repo only reads.
            credential: autId === 'aut_licence' ? null : { secret: 'GITHUB_TOKEN', present: true },
          },
        ],
        runs: countOf([autId]),
        lastRun: lastOf([autId]),
        createdAt: iso(now - 30 * D),
      });
    }
    repoRows.push(
      {
        id: 'repo_gh_widgets',
        kind: 'github',
        name: 'example/widgets',
        url: 'https://github.com/example/widgets.git',
        path: {
          value: '/Users/me/.clerq/workspaces/widgets-3f9a1c2b7d10',
          exists: true,
          role: 'clone',
        },
        credential: { secret: 'GITHUB_TOKEN', present: true },
        // Two automations on one remote, each with its own secret.
        automations: [
          {
            id: 'aut_widgets',
            name: 'widgets-bumps',
            enabled: true,
            credential: { secret: 'GITHUB_TOKEN', present: true },
          },
          {
            id: 'aut_widgets_docs',
            name: 'widgets-docs',
            enabled: false,
            credential: { secret: 'WIDGETS_DOCS_TOKEN', present: false },
          },
        ],
        runs: { queued: 0, running: 0 },
        lastRun: null,
        createdAt: iso(now - 12 * D),
      },
      {
        id: 'repo_gl_tools',
        kind: 'gitlab',
        name: 'lab/tools',
        url: 'https://gitlab.com/lab/tools.git',
        path: null,
        credential: { secret: 'GITLAB_TOKEN', present: false },
        automations: [
          {
            id: 'aut_tools',
            name: 'tools-lint',
            enabled: true,
            credential: { secret: 'GITLAB_TOKEN', present: false },
          },
        ],
        runs: { queued: 0, running: 0 },
        lastRun: null,
        createdAt: iso(now - 2 * D),
      }
    );
  }
  const repoDetail = (id: string): RepoDetail | undefined => {
    const base = repoRows.find((r) => r.id === id);
    if (!base) return undefined;
    const ids = base.automations.map((a) => a.id);
    return {
      ...base,
      recentRuns: runs
        .filter((r) => r.automationId && ids.includes(r.automationId))
        .slice(0, 20)
        .map((r) => summaryOf(r)),
    };
  };

  const approvals: Approval[] = opts.empty
    ? []
    : [
        {
          id: 41,
          runId: 'run_wait01',
          tool: 'git.push',
          tier: 'medium',
          reason:
            'weekly-deps wants to push clerq/weekly-deps-118 to origin and open a draft pull request.',
          requestedAt: iso(now - 32 * 60_000),
        },
        {
          id: 42,
          runId: runs.find((r) => r.status === 'done' && r.automationId)?.id ?? 'run_wait01',
          tool: 'forge.pull_request',
          tier: 'low',
          reason: 'docs-links wants to open a draft pull request on example/site.',
          requestedAt: iso(now - 3 * H),
        },
        {
          id: 43,
          runId: 'run_subs_c',
          parentRunId: 'run_subs01',
          tool: 'runtime.shell',
          tier: 'medium',
          reason:
            'A sub-agent of run run_subs01 wants to run: pnpm why express (checks the lockfile for duplicates).',
          requestedAt: iso(now - 6 * 60_000),
        },
        {
          id: 44,
          runId: 'run_chat02',
          sessionId: 'ses_3',
          tool: 'memory.write.preference',
          tier: 'low',
          reason: 'A chat wants to save a note: “CI triage is read-only”.',
          requestedAt: iso(now - 2 * H),
        },
      ];

  const sessions: Array<ChatSession & { messages: ChatMessage[] }> = opts.empty
    ? []
    : [
        {
          id: 'ses_1',
          title: 'Release notes for 2.4',
          mode: 'managed',
          model: null,
          createdAt: iso(now - 2 * H),
          updatedAt: iso(now - 90 * 60_000),
          messageCount: 2,
          messages: [
            {
              id: 1,
              role: 'user',
              content: 'Draft release notes from the merged pull requests this week.',
              createdAt: iso(now - 2 * H),
            },
            {
              id: 2,
              role: 'assistant',
              content:
                'Release 2.4\n\n- Faster checkout: the basket now loads in one request.\n- Dependency updates for express and zod.\n- Fixed a crash when a coupon expired mid-checkout.',
              createdAt: iso(now - 2 * H + 9000),
              meta: {
                mode: 'managed',
                provider: 'anthropic',
                model: 'claude-sonnet-5-5',
                tokensIn: 4210,
                tokensOut: 312,
                costUsd: 0.0173,
                latencyMs: 8400,
                runId: 'run_chat01',
                request: { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: '…' }] },
              },
            },
          ],
        },
        {
          id: 'ses_2',
          title: 'Which model for summaries?',
          mode: 'raw',
          model: null,
          createdAt: iso(now - D),
          updatedAt: iso(now - D),
          messageCount: 2,
          messages: [
            {
              id: 3,
              role: 'user',
              content: 'Summarise this paragraph in one line.',
              createdAt: iso(now - D),
            },
            {
              id: 4,
              role: 'assistant',
              content: 'A one-line summary.',
              createdAt: iso(now - D + 4000),
              meta: {
                mode: 'compare',
                chosen: 0,
                columns: [
                  {
                    model: 'anthropic/claude-haiku-5-5',
                    text: 'Checkout is faster and safer in 2.4.',
                    tokensIn: 180,
                    tokensOut: 14,
                    costUsd: 0.0002,
                    latencyMs: 900,
                  },
                  {
                    model: 'openai/gpt-5-mini',
                    text: 'Version 2.4 speeds up checkout and fixes a coupon crash.',
                    tokensIn: 176,
                    tokensOut: 19,
                    costUsd: 0.0003,
                    latencyMs: 1600,
                  },
                  {
                    model: 'deepseek/deepseek-chat',
                    text: '2.4: quicker checkout, coupon fix.',
                    tokensIn: 181,
                    tokensOut: 11,
                    costUsd: 0.0001,
                    latencyMs: 2300,
                  },
                ],
              },
            },
          ],
        },
        {
          id: 'ses_3',
          title: 'Weekday CI triage',
          mode: 'managed',
          model: null,
          workspace: '/Users/me/code/shop',
          permissionMode: 'acceptEdits',
          sandboxAvailable: true,
          createdAt: iso(now - 3 * H),
          updatedAt: iso(now - 3 * H),
          messageCount: 2,
          messages: [
            {
              id: 5,
              role: 'user',
              content:
                'Every weekday morning check the shop repo for failing CI on main and summarise what broke.',
              createdAt: iso(now - 3 * H),
            },
            {
              id: 6,
              role: 'assistant',
              content:
                'I drafted weekday-ci-triage. It runs Monday to Friday at 08:00 and only reports; it pushes nothing.',
              createdAt: iso(now - 3 * H + 12_000),
              meta: {
                mode: 'managed',
                provider: 'anthropic',
                model: 'claude-sonnet-5-5',
                tokensIn: 6120,
                tokensOut: 540,
                costUsd: 0.0265,
                latencyMs: 11_800,
                toolCalls: 3,
                runId: 'run_chat02',
                drafts: [{ id: 'drf_1', name: 'weekday-ci-triage' }],
              },
            },
          ],
        },
      ];

  const drafts: ChatDraft[] = [
    {
      id: 'drf_1',
      sessionId: 'ses_3',
      runId: 'run_chat02',
      name: 'weekday-ci-triage',
      source: [
        'name: weekday-ci-triage',
        'on:',
        '  schedule: "0 8 * * 1-5"',
        'targets:',
        '  repos: [local:~/code/shop]',
        'agent:',
        '  driver: claude-code',
        'prompt: Check CI on main and summarise what broke.',
        'publish:',
        '  push: false',
        'budget:',
        '  max_usd_per_run: 1.00',
        '',
      ].join('\n'),
      summary: {
        name: 'weekday-ci-triage',
        schedule: '0 8 * * 1-5',
        nextRunAt: nextFirings('0 8 * * 1-5', 1, new Date(now))[0]?.toISOString() ?? null,
        repo: 'local:~/code/shop',
        driver: 'claude-code',
        model: null,
        push: false,
        pullRequest: 'none',
        pushApproval: 'manual',
        maxUsdPerRun: 1,
        maxUsdPerMonth: null,
        prompt: 'Check CI on main and summarise what broke.',
        gates: [],
        sandbox: { profile: 'native', network: null },
        permissionMode: 'acceptEdits',
        allowedTools: [],
        memoryRead: [],
        memoryIncludeAgent: false,
        warnings: [
          'It runs without isolation: the agent and the gates have your account’s access.',
        ],
      },
      automationId: null,
      savedAt: null,
      dryRunAt: null,
      createdAt: iso(now - 3 * H + 10_000),
    },
  ];

  const providers: ProviderInfo[] = [
    {
      id: 'anthropic',
      label: 'Anthropic',
      local: false,
      ready: !opts.empty,
      reason: opts.empty ? 'Set ANTHROPIC_API_KEY' : undefined,
      defaultModel: 'claude-sonnet-5-5',
      models: [
        { id: 'claude-sonnet-5-5', ref: 'anthropic/claude-sonnet-5-5' },
        { id: 'claude-haiku-5-5', ref: 'anthropic/claude-haiku-5-5' },
      ],
    },
    {
      id: 'openai',
      label: 'OpenAI',
      local: false,
      ready: !opts.empty,
      defaultModel: 'gpt-5-mini',
      models: [{ id: 'gpt-5-mini', ref: 'openai/gpt-5-mini' }],
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      local: false,
      ready: false,
      reason: 'Set DEEPSEEK_API_KEY',
      defaultModel: 'deepseek-chat',
      models: [{ id: 'deepseek-chat', ref: 'deepseek/deepseek-chat' }],
    },
    {
      id: 'ollama',
      label: 'Ollama',
      local: true,
      ready: false,
      reason: 'Not running',
      defaultModel: null,
      models: [],
    },
  ];

  let triggers = {
    cron: [
      {
        id: 'cron-1',
        schedule: '0 9 * * 1-5',
        message: 'Check the support inbox for anything urgent',
      },
    ],
    file: [] as Array<{ id: string; path: string; message: string }>,
    webhooks: { 'webhook-deploys': { message: 'A deploy finished' } } as Record<
      string,
      { message: string }
    >,
  };
  const memoryRecord = (
    id: string,
    type: MemoryType,
    key: string,
    value: unknown,
    created: number,
    extra: Partial<MemoryRecord> = {}
  ): MemoryRecord => ({
    id,
    type,
    key,
    value,
    origin: 'user',
    status: 'active',
    createdAt: iso(created),
    updatedAt: iso(created),
    ...extra,
  });
  const memory: MemoryRecord[] = opts.empty
    ? []
    : [
        memoryRecord('mem_tone', 'preference', 'tone', 'Plain, short sentences.', now - 5 * D),
        memoryRecord('mem_team', 'fact', 'team', { lead: 'Sam', reviewers: 2 }, now - 3 * D),
        memoryRecord(
          'mem_release',
          'procedure',
          'release',
          'Tag on main, then run the release workflow.',
          now - 2 * D
        ),
        memoryRecord('mem_style1', 'preference', 'style', 'Short paragraphs.', now - 9 * D),
        memoryRecord('mem_style2', 'preference', 'style', 'No exclamation marks.', now - 8 * D),
        memoryRecord(
          'mem_ci',
          'note',
          'ci-triage',
          'The checkout test is flaky on Mondays; rerun before reporting it.',
          now - 4 * D,
          { origin: 'agent', sourceSession: 'ses_3' }
        ),
        memoryRecord(
          'mem_deps_sum',
          'decision',
          'deps-policy',
          'Patch and minor updates only; a major version needs a person.',
          now - D,
          { origin: 'consolidation', agentDerived: true }
        ),
        memoryRecord(
          'mem_deps_a',
          'decision',
          'deps-policy',
          'Patch and minor only.',
          now - 12 * D,
          {
            status: 'superseded',
            supersededBy: 'mem_deps_sum',
          }
        ),
        memoryRecord(
          'mem_deps_b',
          'decision',
          'deps-policy',
          'Majors wait for a person to say yes.',
          now - 11 * D,
          { origin: 'agent', status: 'superseded', supersededBy: 'mem_deps_sum' }
        ),
      ];
  let memoryReadTypes: MemoryType[] = ['fact', 'preference', 'decision', 'procedure', 'note'];
  let routingFallback: string[] = [];
  let killed = false;

  const records = opts.empty
    ? []
    : [
        {
          id: 'per_ada',
          ref: 'core:person:per_ada',
          tenantId: 'default',
          type: 'person' as const,
          name: 'Ada Brooks',
          data: { role: 'Operations lead' },
          emails: ['ada@acme.example'],
          phones: ['+442071234567'],
          domains: [],
          createdBy: 'notes',
          createdAt: iso(now - 20 * D),
          updatedAt: iso(now - 3 * H),
        },
        {
          id: 'per_kim',
          ref: 'core:person:per_kim',
          tenantId: 'default',
          type: 'person' as const,
          name: 'Kim Osei',
          data: {},
          emails: ['kim@northwind.example'],
          phones: [],
          domains: [],
          createdBy: 'notes',
          createdAt: iso(now - 9 * D),
          updatedAt: iso(now - D),
        },
        {
          id: 'org_acme',
          ref: 'core:organisation:org_acme',
          tenantId: 'default',
          type: 'organisation' as const,
          name: 'Acme Ltd',
          data: {},
          emails: [],
          phones: [],
          domains: ['acme.example'],
          createdBy: 'notes',
          createdAt: iso(now - 20 * D),
          updatedAt: iso(now - 5 * D),
        },
      ];
  const modules = [
    {
      id: 'notes',
      name: 'Notes',
      version: '0.1.0',
      dir: '~/.clerq/modules/notes',
      status: 'loaded' as const,
      error: null,
      coreEndpoints: [],
      ui: '/api/modules/notes/ui/',
      badge: '3',
      permissions: {
        exec: [],
        fs: { read: [], write: [] },
        net: [],
        secrets: [],
        services: [],
        llm: false,
      },
      permissionWarnings: [],
      triggers: [],
    },
  ];
  const ext = (point: string, items: Array<Record<string, unknown>>) =>
    items.map((i) => ({ moduleId: 'notes', ...i, point }));
  const extensions = {
    nav: ext('nav', [{ id: 'main', title: 'Notes', path: '/' }]),
    'home.tile': ext('home.tile', [
      { id: 'recent', title: 'Recent notes', path: '/tile.html', size: 'm' },
    ]),
    'record.panel': ext('record.panel', [
      {
        id: 'notes',
        title: 'Notes',
        path: '/?ref={ref}',
        types: ['core:person', 'core:organisation'],
      },
    ]),
    'record.action': ext('record.action', [
      {
        id: 'summary',
        title: 'Summarise history',
        trigger: 'summarise',
        confirm: true,
        types: ['core:person'],
      },
      { id: 'new', title: 'New note', path: '/new?ref={ref}' },
    ]),
    search: [],
    'inbox.item': [],
    'settings.page': ext('settings.page', [
      { id: 'prefs', title: 'Notes', path: '/settings.html' },
    ]),
  };
  const inboxItems = opts.empty
    ? []
    : [
        {
          id: 'inb_1',
          moduleId: 'notes',
          externalId: 'n-81',
          kind: 'reply' as const,
          title: 'Ada Brooks asked about the renewal',
          body: 'Can we keep last year’s price if we sign before Friday?',
          ref: 'core:person:per_ada',
          link: '/thread/81',
          status: 'open' as 'open' | 'done' | 'dismissed',
          priority: 1,
          dueAt: iso(now + D),
          createdAt: iso(now - 3 * H),
          updatedAt: iso(now - 3 * H),
          resolvedAt: null,
          resolvedBy: null,
        },
        {
          id: 'inb_2',
          moduleId: 'notes',
          externalId: 'n-82',
          kind: 'task' as const,
          title: 'Send Kim the signed contract',
          body: null,
          ref: 'core:person:per_kim',
          link: null,
          status: 'open' as 'open' | 'done' | 'dismissed',
          priority: 0,
          dueAt: null,
          createdAt: iso(now - D),
          updatedAt: iso(now - D),
          resolvedAt: null,
          resolvedBy: null,
        },
      ];
  let remote = {
    enabled: !opts.empty,
    publicUrl: opts.empty ? null : 'https://clerq.example.com',
    ntfyServer: 'https://ntfy.sh',
  } as { enabled: boolean; publicUrl: string | null; ntfyServer: string };
  const devices = [
    {
      id: 'dev_1',
      tenantId: 'default',
      name: 'Sam’s iPhone',
      platform: 'ios',
      createdAt: iso(now - 6 * D),
      lastSeenAt: iso(now - 20 * 60_000),
      revokedAt: null as string | null,
      push: { server: 'https://ntfy.sh', topic: 'x' },
    },
    {
      id: 'dev_2',
      tenantId: 'default',
      name: 'Old Pixel',
      platform: 'android',
      createdAt: iso(now - 40 * D),
      lastSeenAt: iso(now - 30 * D),
      revokedAt: iso(now - 29 * D) as string | null,
      push: null,
    },
  ];

  const fail = () => Promise.reject(new TypeError('Failed to fetch'));
  const ok = <T>(v: T) =>
    opts.offline ? fail() : new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 30));
  // A run as the list shows it: no steps, tool calls, files or children.
  function summaryOf(r: RunDetail): RunSummary {
    const rest = { ...r } as Partial<RunDetail>;
    delete rest.steps;
    delete rest.artifacts;
    delete rest.toolCalls;
    delete rest.children;
    return rest as RunSummary;
  }

  const client = {
    // The preview serves a demo module UI at /api/modules/notes/ui/, so frames load there.
    getUrl: () =>
      typeof location !== 'undefined' && location.origin.startsWith('http')
        ? location.origin
        : 'http://127.0.0.1:18790',
    // No streams: pages fall back to polling, and headless screenshots can finish.
    logsStreamUrl: () => '',
    health: () =>
      ok({
        status: 'ok',
        service: 'clerq-gateway',
        version: '0.6.0',
        llm: {
          mode: 'api' as const,
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          available: !opts.empty,
        },
      }),
    metrics: () =>
      ok({
        version: '0.6.0',
        uptime_seconds: 52_000,
        service: 'clerq-gateway',
        llm_calls_total: 412,
        llm_calls_failed: 3,
        llm_avg_latency_ms: 2100,
        llm_input_tokens_total: 9_120_000,
        llm_output_tokens_total: 640_000,
        llm_cost_usd_total: 38.42,
        llm_unpriced_calls_total: 0,
      }),
    models: () =>
      ok({ models: ['claude-sonnet-5-5', 'claude-haiku-5-5'], current: 'claude-sonnet-5-5' }),
    providers: () =>
      ok({ providers, current: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }),
    routing: () =>
      ok({
        default: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        fallback: routingFallback,
        maxFallback: 5,
      }),
    setRouting: (fallback: string[]) => {
      const unknown = fallback.find((m) => !providers.some((p) => p.id === m.split('/')[0]));
      if (unknown) {
        return Promise.reject(
          Object.assign(new Error('Gateway 400'), {
            body: {
              error: 'invalid_routing',
              message: `Unknown provider in "${unknown}". Known: ${providers.map((p) => p.id).join(', ')}.`,
            },
          })
        );
      }
      routingFallback = [...fallback];
      return ok({ fallback: routingFallback });
    },
    repos: () => ok({ repos: repoRows }),
    repo: (id: string) => {
      const r = repoDetail(id);
      return r
        ? ok(r)
        : Promise.reject(
            Object.assign(new Error('Gateway 404: {"error":"repo_not_found"}'), {
              status: 404,
              body: { error: 'repo_not_found' },
            })
          );
    },
    automations: () => ok({ automations: automations.map(({ source: _s, ...a }) => a) }),
    automation: (id: string) => {
      const a = automations.find((x) => x.id === id);
      return a ? ok(a) : Promise.reject(new Error('Not found'));
    },
    previewAutomation: (spec: string) =>
      ok({
        nextRunAt: null,
        nextFirings: [],
        repo: {
          path: '~/code/shop',
          origin: 'git@github.com:example/shop.git',
          project: 'example/shop',
          base: 'main',
        },
        driver: { id: 'claude-code', available: true, version: '2.1.0' },
        checks: /name:\s*\S/.test(spec)
          ? [
              {
                level: 'ok' as const,
                message: 'The repository is a git checkout with an origin on GitHub.',
              },
              { level: 'ok' as const, message: 'claude-code 2.1.0 is installed.' },
              {
                level: 'warning' as const,
                message: 'No GitHub token in Secrets: the push will fail. Add GITHUB_TOKEN.',
              },
            ]
          : [{ level: 'error' as const, message: 'name is required (line 1)' }],
        ready: true,
      }),
    createAutomation: (spec: string) =>
      ok({
        ...automations[0],
        id: 'aut_new',
        name: /name:\s*(\S+)/.exec(spec)?.[1] ?? 'new',
        source: spec,
        enabled: false,
      }),
    updateAutomation: (id: string, spec: string) => {
      const a = automations.find((x) => x.id === id);
      if (a) a.source = spec;
      return ok(a);
    },
    deleteAutomation: (id: string) => {
      const i = automations.findIndex((a) => a.id === id);
      if (i >= 0) automations.splice(i, 1);
      return ok({ ok: true });
    },
    setAutomationEnabled: (id: string, enabled: boolean) => {
      const a = automations.find((x) => x.id === id);
      if (a) a.enabled = enabled;
      return ok(a);
    },
    runAutomation: () => ok({ runId: 'run_live01' }),
    runs: (limit = 50, o?: { since?: string | Date }) => {
      const since = o?.since ? new Date(o.since).getTime() : 0;
      return ok({
        runs: runs
          .filter((r) => Date.parse(r.createdAt) >= since)
          .slice(0, limit)
          .map(summaryOf),
      });
    },
    run: (id: string) => {
      const r = runs.find((x) => x.id === id);
      return r
        ? ok(r)
        : Promise.reject(
            Object.assign(new Error('Gateway 404: {"error":"run_not_found"}'), {
              status: 404,
              body: { error: 'run_not_found', message: 'No run with that id.' },
            })
          );
    },
    artifact: (_runId: string, artifactId: number) =>
      ok({
        id: artifactId,
        kind: 'diff',
        name: 'changes.diff',
        size: DIFF.length,
        sha256: '',
        content: DIFF,
      }),
    cancelRun: (id: string) => {
      const r = runs.find((x) => x.id === id);
      if (r) r.status = 'cancelled';
      return ok({ ok: true, id });
    },
    approvals: () => ok({ approvals: killed ? [] : approvals }),
    inbox: () =>
      ok({
        items: [
          ...(killed ? [] : approvals).map((a) => ({
            id: `apr_${a.id}`,
            moduleId: null,
            externalId: null,
            kind: 'approval' as const,
            title:
              a.tool === 'git.push'
                ? 'Approve push for weekly-deps'
                : a.tool === 'runtime.shell'
                  ? 'Approve a command from a sub-agent of flaky-tests'
                  : a.tool.startsWith('memory.write')
                    ? 'Approve saving a note from a chat'
                    : 'Approve pull request for docs-links',
            body: a.reason,
            ref: null,
            link: null,
            status: 'open' as const,
            priority: 2,
            dueAt: null,
            runId: a.runId,
            createdAt: a.requestedAt,
            updatedAt: a.requestedAt,
            resolvedAt: null,
            resolvedBy: null,
          })),
          ...inboxItems.filter((i) => i.status === 'open'),
        ],
      }),
    setInboxStatus: (id: string, status: 'open' | 'done' | 'dismissed') => {
      const i = inboxItems.find((x) => x.id === id);
      if (i) i.status = status;
      return ok(i);
    },
    respondInboxItem: (id: string) => {
      const i = inboxItems.find((x) => x.id === id);
      if (i) i.status = 'done';
      return ok({ item: i, result: { ok: true } });
    },
    modules: () => ok({ modules: opts.empty ? [] : modules }),
    moduleToken: () =>
      ok({ token: 'clqm_fixture', expiresAt: iso(Date.now() + 15 * 60_000), scopes: [] }),
    revokeModuleTokens: () => ok({ ok: true, revoked: 0 }),
    fireModuleTrigger: () => ok({ runId: 'run_live01' }),
    extensions: () => ok(opts.empty ? {} : extensions),
    records: (o: { type?: string; q?: string } = {}) =>
      ok({
        records: records.filter(
          (r) =>
            (!o.type || r.type === o.type) &&
            (!o.q ||
              `${r.name} ${r.emails.join(' ')} ${r.domains.join(' ')}`
                .toLowerCase()
                .includes(o.q.toLowerCase()))
        ),
      }),
    record: (id: string) => {
      const r = records.find((x) => x.id === id);
      return r
        ? ok({
            ...r,
            links:
              r.type === 'person'
                ? [
                    {
                      from: r.ref,
                      to: 'core:organisation:org_acme',
                      kind: 'works_at',
                      createdBy: 'notes',
                      createdAt: iso(now - 4 * D),
                    },
                  ]
                : [],
          })
        : Promise.reject(new Error('No record with that id.'));
    },
    activities: (id: string) =>
      ok({
        activities:
          id === 'per_ada'
            ? [
                {
                  ...records[0],
                  id: 'act_1',
                  ref: 'core:activity:act_1',
                  type: 'activity' as const,
                  name: 'Replied about the renewal',
                  data: { kind: 'email', at: iso(now - 3 * H) },
                },
                {
                  ...records[0],
                  id: 'act_2',
                  ref: 'core:activity:act_2',
                  type: 'activity' as const,
                  name: 'Call: pricing questions',
                  data: { kind: 'call', at: iso(now - 2 * D) },
                },
              ]
            : [],
      }),
    links: () => ok({ links: [] }),
    search: (q: string) =>
      ok({
        results: records
          .filter((r) => (r.name ?? '').toLowerCase().includes(q.toLowerCase()))
          .map((r) => ({
            ref: r.ref,
            moduleId: 'core',
            type: r.type,
            title: r.name ?? r.ref,
            subtitle: r.emails[0] ?? r.domains[0],
            score: 1,
          })),
        errors: [],
      }),
    remote: () => ok(remote),
    setRemote: (patch: Partial<typeof remote>) => {
      remote = { ...remote, ...patch };
      return ok(remote);
    },
    createPairingCode: () => {
      const code = 'K7QX2-9MWPD';
      const expiresAt = iso(Date.now() + 5 * 60_000);
      return ok({
        code,
        url: remote.publicUrl ?? 'https://clerq.example.com',
        expiresAt,
        qr: JSON.stringify({
          url: remote.publicUrl ?? 'https://clerq.example.com',
          code,
          expires: expiresAt,
        }),
      });
    },
    devices: () => ok({ devices: opts.empty ? [] : devices }),
    revokeDevice: (id: string) => {
      const d = devices.find((x) => x.id === id);
      if (d) d.revokedAt = iso(now);
      return ok(d);
    },
    decideApproval: (id: number) => {
      const i = approvals.findIndex((a) => a.id === id);
      if (i >= 0) approvals.splice(i, 1);
      return ok({ ok: true });
    },
    sessions: () => ok({ sessions: sessions.map(({ messages: _m, ...s }) => s) }),
    session: (id: string) => {
      const s = sessions.find((x) => x.id === id);
      return s ? ok(s) : Promise.reject(new Error('No conversation with that id.'));
    },
    createSession: (input: { mode?: 'raw' | 'managed'; title?: string } = {}) => {
      const s = {
        id: `ses_${sessions.length + 1}${Date.now() % 1000}`,
        title: input.title ?? null,
        mode: input.mode ?? 'raw',
        model: null,
        createdAt: iso(now),
        updatedAt: iso(now),
        messageCount: 0,
        messages: [],
      };
      sessions.unshift(s);
      return ok(s);
    },
    updateSession: (id: string, patch: { mode?: 'raw' | 'managed' }) => {
      const s = sessions.find((x) => x.id === id);
      if (s && patch.mode) s.mode = patch.mode;
      return ok(s);
    },
    deleteSession: (id: string) => {
      const i = sessions.findIndex((s) => s.id === id);
      if (i >= 0) sessions.splice(i, 1);
      return ok({ ok: true });
    },
    sendMessage: async (id: string, input: { text: string }, onDelta?: (t: string) => void) => {
      const s = sessions.find((x) => x.id === id);
      const answer = 'This is a fixture answer.';
      for (const w of answer.split(' ')) {
        await new Promise((r) => setTimeout(r, 40));
        onDelta?.(`${w} `);
      }
      const message: ChatMessage = {
        id: Date.now(),
        role: 'assistant',
        content: answer,
        createdAt: iso(now),
        meta: {
          mode: s?.mode ?? 'raw',
          model: 'claude-sonnet-5-5',
          tokensIn: 12,
          tokensOut: 6,
          costUsd: 0.0001,
          latencyMs: 400,
        },
      };
      s?.messages.push(
        { id: Date.now() - 1, role: 'user', content: input.text, createdAt: iso(now) },
        message
      );
      if (s) s.messageCount = s.messages.length;
      return { runId: 'run_chat', message };
    },
    compare: () => ok({ runId: 'run_cmp', messageId: 4, columns: [] }),
    modeDiff: (id: string, input: { text: string }) => {
      const s = sessions.find((x) => x.id === id);
      const messages = [
        ...(s?.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: input.text },
      ];
      return ok({
        raw: {
          system: null,
          messages,
          tools: [],
          memory: null,
          model: 'anthropic/claude-sonnet-5-5',
          fallbackModels: [],
        },
        managed: {
          system:
            'You are Clerq…\n\n<memory>\n- [preference] tone: British English\n</memory>\n\nYou can use tools in this conversation.',
          messages,
          skill: null,
          memory: { text: '<memory>…</memory>', count: 1 },
          tools: [
            { name: 'memory.search', modelName: 'search_memory', risk: 'read', decision: 'allow' },
            { name: 'memory.write', modelName: 'save_memory', risk: 'write', decision: 'allow' },
            {
              name: 'automation.draft',
              modelName: 'draft_automation',
              risk: 'read',
              decision: 'allow',
            },
          ],
          model: 'anthropic/claude-sonnet-5-5',
          chosen: false,
          fallbackModels: ['openai/gpt-5-mini'],
          workspace: s?.workspace ?? null,
          permissionMode: s?.permissionMode ?? 'acceptEdits',
        },
      });
    },
    drafts: (id: string) => ok({ drafts: drafts.filter((d) => d.sessionId === id) }),
    draft: (id: string, draftId: string) => {
      const d = drafts.find((x) => x.sessionId === id && x.id === draftId);
      return d ? ok(d) : Promise.reject(new Error('No draft with that id.'));
    },
    dryRunDraft: (_id: string, draftId: string) => {
      const d = drafts.find((x) => x.id === draftId);
      if (d) d.dryRunAt = iso(now);
      return ok({
        draftId,
        nextRunAt: nextFirings('0 8 * * 1-5', 1, new Date(now))[0]?.toISOString() ?? null,
        nextFirings: nextFirings('0 8 * * 1-5', 10, new Date(now)).map((d) => d.toISOString()),
        repo: { target: 'local:~/code/shop', path: '/Users/me/code/shop' },
        driver: { id: 'claude-code', available: true },
        checks: [
          { level: 'ok', message: 'No push: the run only reports.' },
          {
            level: 'warning',
            message:
              'The agent and the gates run without isolation (profile "native"), with your account\'s access to files and the network.',
          },
        ],
        ready: true,
        timeZone: 'Europe/Tallinn',
        estimate: {
          perRunUsd: 0.42,
          perMonthUsd: 9.24,
          basedOnRuns: 12,
          firingsPerMonth: 22,
          capPerRunUsd: 1,
          capPerMonthUsd: null,
          note: 'Average of the last 12 finished runs of claude-code.',
        },
        executed: false,
      });
    },
    saveDraft: (_id: string, draftId: string) => {
      const d = drafts.find((x) => x.id === draftId);
      if (d) {
        d.automationId = `aut_${draftId}`;
        d.savedAt = iso(now);
      }
      return ok({
        id: `aut_${draftId}`,
        name: d?.name ?? draftId,
        enabled: false,
        authoredBy: `chat ${d?.sessionId ?? ''}`,
        source: d?.source ?? '',
      });
    },
    runToolCalls: () => ok({ toolCalls: [] }),
    promote: (id: string, messageId: number, index: number) => {
      const m = sessions.find((s) => s.id === id)?.messages.find((x) => x.id === messageId);
      if (m?.meta) m.meta.chosen = index;
      return ok(m);
    },
    kill: () => {
      killed = true;
      return ok({
        ok: true,
        deniedApprovals: approvals.length,
        cancelledRuns: 1,
        triggersPaused: true,
      });
    },
    killStatus: () =>
      ok({ triggersPaused: killed, since: killed ? iso(now) : null, activeRuns: 1 }),
    resume: () => {
      killed = false;
      return ok({ ok: true, triggersResumed: true, wasPaused: true });
    },
    drivers: () => ok({ drivers: [{ id: 'claude-code', available: true, version: '2.1.0' }] }),
    secrets: () =>
      ok({
        secrets: opts.empty ? [] : ['GITHUB_TOKEN', 'SENTRY_DSN'],
        keySource: 'keychain' as const,
        keychain: 'login',
      }),
    setSecret: () => ok({ ok: true }),
    deleteSecret: () => ok({ ok: true }),
    triggers: () => ok(triggers),
    saveTriggers: (t: typeof triggers) => {
      triggers = t;
      return ok({ ok: true });
    },
    systemPrompt: () =>
      ok({ prompt: '', default: 'You are Clerq, an assistant for local administrative work.' }),
    saveSystemPrompt: () => ok({ ok: true }),
    reasoning: () => ok({ temperature: 0.2, maxTokens: 2048 }),
    saveReasoning: () => ok({ ok: true }),
    capabilities: () => ok({ fsRoot: '~/Documents/clerq', httpAllowlist: ['api.github.com'] }),
    saveCapabilities: () => ok({ ok: true }),
    skills: () =>
      ok({
        source: '~/.clerq/skills',
        skills: opts.empty
          ? []
          : [
              {
                slug: 'vat-core',
                name: 'VAT',
                description: 'VAT rules and rates',
                version: '1.2.0',
              },
              {
                slug: 'payroll-base',
                name: 'Payroll',
                description: 'Gross to net',
                version: '0.9.1',
              },
            ],
      }),
    skill: (slug: string) =>
      ok({
        meta: { slug, name: slug, description: 'A skill.', inputSchema: { type: 'object' } },
        body: '# Instructions\n\nExplain the rule, then point to the engine for the number.',
      }),
    updateSkill: () => ok({ ok: true }),
    memory: () => ok({ entries: memory.filter((m) => m.status === 'active') }),
    getMemory: (key: string) => ok(memory.find((m) => m.key === key)),
    setMemory: () => ok({ ok: true }),
    deleteMemory: () => ok({ ok: true }),
    memoryRecords: (
      f: { status?: 'active' | 'superseded' | 'all'; type?: MemoryType; key?: string } = {}
    ) =>
      ok({
        records: memory.filter(
          (m) =>
            (f.status === 'all' || m.status === (f.status ?? 'active')) &&
            (!f.type || m.type === f.type) &&
            (!f.key || m.key === f.key)
        ),
      }),
    addMemoryRecord: (input: { key: string; value: unknown; type?: MemoryType }) => {
      const record = memoryRecord(
        `mem_${memory.length + 1}`,
        input.type ?? 'fact',
        input.key,
        input.value,
        now
      );
      memory.push(record);
      return ok({ record });
    },
    updateMemoryRecord: () => ok({ record: memory[0] }),
    deleteMemoryRecord: (id: string) => {
      const i = memory.findIndex((m) => m.id === id);
      if (i >= 0) {
        // A summary takes the records folded into it along.
        for (let j = memory.length - 1; j >= 0; j--) {
          if (memory[j].supersededBy === id) memory.splice(j, 1);
        }
        memory.splice(
          memory.findIndex((m) => m.id === id),
          1
        );
      }
      return ok({ ok: true });
    },
    searchMemory: (q: string) =>
      ok({
        query: q,
        mode: 'fts5' as const,
        results: memory
          .filter(
            (m) =>
              m.status === 'active' &&
              `${m.key} ${JSON.stringify(m.value)}`.toLowerCase().includes(q.toLowerCase())
          )
          .map((m) => ({ ...m, score: 1 })),
      }),
    consolidateMemory: (key: string, o: { type?: MemoryType; model?: string } = {}) => {
      const sources = memory.filter(
        (m) => m.key === key && m.status === 'active' && (!o.type || m.type === o.type)
      );
      if (sources.length < 2) {
        return Promise.reject(
          Object.assign(new Error('Gateway 409'), {
            body: {
              error: 'cannot_consolidate',
              message: `"${key}" has ${sources.length} record in use; summarising needs at least two.`,
            },
          })
        );
      }
      const record = memoryRecord(
        `mem_sum_${memory.length + 1}`,
        sources[0].type,
        key,
        `A summary of ${sources.length} records under ${key}.`,
        now,
        {
          origin: 'consolidation',
          ...(sources.some((s) => s.origin === 'agent' || s.agentDerived)
            ? { agentDerived: true as const }
            : {}),
        }
      );
      for (const s of sources) {
        s.status = 'superseded';
        s.supersededBy = record.id;
      }
      memory.push(record);
      return ok({ record, superseded: sources.map((s) => s.id), model: o.model });
    },
    unconsolidateMemory: (id: string) => {
      const restored = memory.filter((m) => m.supersededBy === id);
      for (const m of restored) {
        m.status = 'active';
        delete m.supersededBy;
      }
      const i = memory.findIndex((m) => m.id === id);
      if (i >= 0) memory.splice(i, 1);
      return ok({ restored: restored.map((m) => m.id) });
    },
    memoryPolicy: () =>
      ok({
        readTypes: memoryReadTypes,
        types: ['fact', 'preference', 'decision', 'procedure', 'note'] as MemoryType[],
      }),
    setMemoryPolicy: (readTypes: MemoryType[]) => {
      memoryReadTypes = [...readTypes];
      return ok({
        readTypes: memoryReadTypes,
        types: ['fact', 'preference', 'decision', 'procedure', 'note'] as MemoryType[],
      });
    },
    calculateEval: () =>
      ok({
        values: { net: 100, tax: 25 },
        proof: { steps: ['net = gross / 1.25 = 100', 'tax = gross - net = 25'] },
      }),
    filingPrep: () => ok({ form_type: 'x', draft: {}, status: 'draft' }),
    explain: () =>
      ok({
        explanation: 'An explanation.',
        model: 'claude-sonnet-5-5',
        disclaimer: 'Numbers come from the calculation engine.',
      }),
    contextPreview: (b: { question?: string }) =>
      ok({
        systemPrompt: 'You are Clerq…',
        history: [],
        userContent: b.question ?? '',
        estimatedInputTokens: 412,
      }),
    task: () =>
      ok({
        intent: 'explain' as const,
        explanation: 'Done: nothing pending.',
        model: 'claude-sonnet-5-5',
      }),
    tools: () =>
      ok({
        tools: [
          { name: 'fs.read', description: 'Read a file under the allowed folder.' },
          { name: 'http.request', description: 'Call an allowed web host.' },
        ],
      }),
    runTool: (name: string) => ok({ name, result: { content: '# Example\n\nA file.' } }),
  };
  return client as unknown as GatewayClient;
}

/** Midday on a fixed Wednesday, for screenshots that do not change from run to run. */
export const FIXTURE_NOW = Date.UTC(2026, 10, 11, 11, 0, 0);
