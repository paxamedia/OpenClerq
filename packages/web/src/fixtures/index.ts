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
  ChatMessage,
  ChatSession,
  ProviderInfo,
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
  const memory = opts.empty
    ? []
    : [
        { key: 'tone', value: 'Plain, short sentences.', createdAt: iso(now - 5 * D) },
        { key: 'team', value: { lead: 'Sam', reviewers: 2 }, createdAt: iso(now - 3 * D) },
      ];
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
  const summary = (r: RunDetail): RunSummary => {
    const rest = { ...r } as Partial<RunDetail>;
    delete rest.steps;
    delete rest.artifacts;
    return rest as RunSummary;
  };

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
        fallback: [] as string[],
        maxFallback: 5,
      }),
    setRouting: (fallback: string[]) => ok({ fallback }),
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
          .map(summary),
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
    memory: () => ok({ entries: memory }),
    getMemory: (key: string) => ok(memory.find((m) => m.key === key)),
    setMemory: () => ok({ ok: true }),
    deleteMemory: () => ok({ ok: true }),
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
