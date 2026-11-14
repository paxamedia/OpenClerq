/**
 * Operator endpoints for modules: what is loaded, and tokens for module UIs.
 * (The plugin list, approvals and the enforcement setting are in plugin-routes.ts.)
 */

import type { Express, Request, Response } from 'express';
import { issueToken, revokeTokens } from '../security/scoped-tokens.js';
import { currentTenant } from '../tenant.js';
import { uiDir, type ModuleHost } from './host.js';
import { coreEndpointsOf } from './permissions.js';
import { badgeOf } from './notify.js';
import { EXTENSION_POINTS, emptyExtensions } from './extensions.js';
import { search } from './search.js';

const DEFAULT_TTL_S = 15 * 60;
const MAX_TTL_S = 24 * 60 * 60;

/**
 * What a module UI's token reaches: its own routes, and the core endpoints it declares:
 * the plugin's `permissions.api`, and a legacy module's `coreEndpoints` (also read from
 * `permissions.api`).
 */
export function moduleScopes(id: string, declaredApi: readonly string[]): string[] {
  return [`* /api/modules/${id}/*`, ...declaredApi];
}

export function mountModuleRoutes(app: Express, host: ModuleHost): void {
  // Where the modules' own routes belong in the order of the stack.
  host.mountDispatcher();

  /**
   * The modules that are running or failed, as it has always listed them; `kind` and `state`
   * are additions. A plugin that is switched off, waiting for approval or refused is not here:
   * `GET /plugins` has them.
   */
  app.get('/modules', (_req: Request, res: Response) => {
    res.json({
      modules: host
        .list()
        .filter((h) => h.state === 'enabled' || h.state === 'failed')
        .map((h) => ({
          id: h.module.id,
          name: h.module.manifest.name ?? h.module.id,
          version: h.module.manifest.version ?? null,
          dir: h.module.dir,
          status: h.status,
          kind: h.kind,
          state: h.state,
          error: h.error ?? null,
          coreEndpoints: coreEndpointsOf(h.module.manifest),
          ui:
            h.state === 'enabled' &&
            uiDir(h.module.stageDir ?? h.module.dir, h.discovered.plugin?.entry.ui)
              ? `/api/modules/${h.module.id}/ui/`
              : null,
          triggers: host.triggers.list(h.module.id),
          badge: badgeOf(h.module.id),
          permissions: h.permissions,
          permissionWarnings: h.permissionWarnings,
          extensions: h.extensions,
          extensionWarnings: h.extensionWarnings,
        })),
    });
  });

  /** Every loaded module's extension points, each item tagged with its module. */
  app.get('/extensions', (_req: Request, res: Response) => {
    const all = emptyExtensions() as unknown as Record<string, Array<Record<string, unknown>>>;
    for (const h of host.list()) {
      if (h.state !== 'enabled') continue;
      for (const point of EXTENSION_POINTS) {
        for (const item of h.extensions[point]) all[point].push({ moduleId: h.module.id, ...item });
      }
    }
    for (const point of EXTENSION_POINTS) {
      all[point].sort(
        (a, b) =>
          Number(a.order ?? 0) - Number(b.order ?? 0) ||
          String(a.title ?? a.id).localeCompare(String(b.title ?? b.id))
      );
    }
    res.json(all);
  });

  /** Core records and every module's search handler at once. */
  app.get('/search', async (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return res.status(400).json({ error: 'q_required', message: 'Pass ?q=.' });
    const types = typeof req.query.types === 'string' ? req.query.types.split(',') : undefined;
    res.json(await search(q, { limit: Number(req.query.limit) || undefined, types }));
  });

  /**
   * A short-lived token for a module's UI: the desktop hands it to the module's
   * iframe. Default 15 minutes, at most 24 hours.
   */
  app.post('/modules/:id/token', (req: Request, res: Response) => {
    const hosted = host.get(String(req.params.id));
    if (!hosted || hosted.state !== 'enabled') {
      return res.status(404).json({ error: 'module_not_found', message: 'No such loaded module.' });
    }
    const body = (req.body ?? {}) as { ttlSeconds?: unknown };
    const ttl =
      typeof body.ttlSeconds === 'number' && body.ttlSeconds > 0
        ? Math.min(Math.floor(body.ttlSeconds), MAX_TTL_S)
        : DEFAULT_TTL_S;
    const scopes = moduleScopes(hosted.module.id, hosted.declared.api);
    const { token, expiresAt } = issueToken({
      kind: 'module',
      subject: hosted.module.id,
      scopes,
      ttlMs: ttl * 1000,
      tenantId: currentTenant(),
    });
    res.status(201).json({ token, expiresAt, scopes, tenantId: currentTenant() });
  });

  /** Revoke every token issued for a module's UI. */
  app.delete('/modules/:id/tokens', (req: Request, res: Response) => {
    res.json({ ok: true, revoked: revokeTokens('module', String(req.params.id)) });
  });
}
