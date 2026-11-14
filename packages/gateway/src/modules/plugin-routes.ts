/**
 * Operator endpoints for plugins: the list with its states and what was approved,
 * enable, disable, approve, and the one setting, enforcement.
 *
 *   GET  /plugins                    every module and plugin, legacy ones included
 *   POST /plugins/:id/enable
 *   POST /plugins/:id/disable
 *   POST /plugins/:id/approve        { permissionsHash, checksum }, both as listed now
 *   GET  /plugins/settings           { enforce }
 *   PUT  /plugins/settings           { enforce: boolean }
 *
 * `/plugins` is operator-only (security/scoped-tokens.ts): a module's UI token or a
 * phone's cannot reach it, whatever its scopes say.
 */

import type { Express, Request, Response } from 'express';
import { diffPermissions, type PermissionChange } from '@clerq/plugin-sdk/manifest';
import type { PluginPermissions } from '@clerq/plugin-sdk';
import { actorOf } from '../records/routes.js';
import { logger } from '../logger.js';
import {
  approvalOf,
  PluginError,
  readFacts,
  uiDir,
  type ApprovalStatus,
  type HostedModule,
  type ModuleHost,
} from './host.js';
import { readPluginRow, type PluginKind, type PluginStateName } from './plugin-state.js';

/** What `GET /plugins` says of one plugin. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  /** `plugin` has a manifest of version 1; `legacy` is a module written before it. */
  kind: PluginKind;
  dir: string;
  state: PluginStateName;
  /** Why it is not enabled: the error, the engine, what it waits for. */
  reason: string | null;
  /** The person turned it off. It stays off until they turn it on. */
  switchedOff: boolean;
  /** The OpenClerq API version it needs; null for a legacy module. */
  engine: number | null;
  /** What the manifest on disk declares. */
  permissions: PluginPermissions;
  /** Of the declarations and the code on disk: what an approval names. */
  permissionsHash: string | null;
  checksum: string | null;
  warnings: string[];
  approval: {
    status: ApprovalStatus;
    approvedAt: string | null;
    approvedBy: string | null;
    approvedVersion: string | null;
    changes: { code: boolean; permissions: boolean; version: boolean };
    /** What it can do now that it could not when it was approved, and the reverse. */
    permissionChanges: PermissionChange[];
  };
  /** The files on disk differ from what is running: disable and enable it, or restart. */
  needsRestart: boolean;
  /** Where its UI is served; null without one, or when it is not running. */
  ui: string | null;
}

export function pluginInfo(h: HostedModule): PluginInfo {
  const id = h.module.id;
  const row = readPluginRow(id);
  const fresh = readFacts(h.discovered.dir);
  const facts = 'problem' in fresh ? h.current : fresh;
  const warnings = [
    ...('problem' in fresh ? [fresh.problem] : []),
    ...(facts.readProblem ? [facts.readProblem] : []),
    ...(facts.discovered.manifestWarnings ?? []),
    ...(h.kind === 'legacy' ? h.permissionWarnings : []),
  ];
  const approval = approvalOf(row, facts);
  const a = row?.approval;
  const manifest = facts.discovered.manifest;
  const version = String(manifest.version ?? '') || null;
  const running = h.state === 'enabled' && h.loaded !== undefined;
  return {
    id,
    name: String(manifest.name ?? id),
    version,
    description:
      typeof manifest.description === 'string' && manifest.description
        ? manifest.description
        : null,
    kind: h.kind,
    dir: h.discovered.dir,
    state: h.state,
    reason: h.reason ?? null,
    switchedOff: row?.desired === 'disabled',
    engine: h.discovered.plugin?.engines.api ?? null,
    permissions: facts.declared,
    permissionsHash: facts.permissionsHash,
    checksum: facts.checksum,
    warnings,
    approval: {
      status: approval.status,
      approvedAt: a?.at || null,
      approvedBy: a?.by ?? null,
      approvedVersion: a?.version ?? null,
      changes: { ...approval.changes, version: !!a && a.version !== version },
      permissionChanges:
        a?.permissions && approval.status === 'changed'
          ? diffPermissions(a.permissions, facts.declared)
          : [],
    },
    needsRestart:
      running &&
      (h.loaded?.checksum !== facts.checksum ||
        h.loaded?.permissionsHash !== facts.permissionsHash),
    ui:
      h.state === 'enabled' && uiDir(h.discovered.dir, h.discovered.plugin?.entry.ui)
        ? `/api/modules/${id}/ui/`
        : null,
  };
}

export function mountPluginRoutes(app: Express, host: ModuleHost): void {
  const fail = (res: Response, e: unknown, fallback: string): Response => {
    if (e instanceof PluginError) {
      const status = { not_found: 404, stale: 409, not_approvable: 409, invalid: 400 }[e.code];
      const error = e.code === 'stale' ? 'approval_stale' : e.code;
      return res.status(status).json({ error, message: e.message });
    }
    logger.error('plugin request failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    return res.status(500).json({ error: fallback });
  };

  app.get('/plugins', (_req: Request, res: Response) => {
    try {
      res.json({ plugins: host.list().map(pluginInfo), enforce: host.enforcing() });
    } catch (e) {
      fail(res, e, 'plugins_failed');
    }
  });

  app.get('/plugins/settings', (_req: Request, res: Response) => {
    res.json({ enforce: host.enforcing() });
  });

  app.put('/plugins/settings', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { enforce?: unknown };
    if (typeof body.enforce !== 'boolean') {
      return res
        .status(400)
        .json({ error: 'invalid_request', message: '"enforce" must be true or false.' });
    }
    try {
      await host.setEnforce(body.enforce, actorOf(res));
      res.json({ enforce: host.enforcing() });
    } catch (e) {
      fail(res, e, 'plugins_settings_failed');
    }
  });

  for (const action of ['enable', 'disable'] as const) {
    app.post(`/plugins/:id/${action}`, async (req: Request, res: Response) => {
      try {
        const entry = await host[action](String(req.params.id), actorOf(res));
        res.json({ plugin: pluginInfo(entry) });
      } catch (e) {
        fail(res, e, `plugin_${action}_failed`);
      }
    });
  }

  app.post('/plugins/:id/approve', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { permissionsHash?: unknown; checksum?: unknown };
    if (typeof body.permissionsHash !== 'string' || typeof body.checksum !== 'string') {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'Send the "permissionsHash" and "checksum" the list showed.',
      });
    }
    try {
      const entry = await host.approve(
        String(req.params.id),
        { permissionsHash: body.permissionsHash, checksum: body.checksum },
        actorOf(res)
      );
      res.json({ plugin: pluginInfo(entry) });
    } catch (e) {
      fail(res, e, 'plugin_approve_failed');
    }
  });
}
