/**
 * Operator endpoints for modules: what is loaded, and tokens for module UIs.
 */

import type { Express, Request, Response } from 'express';
import { issueToken, revokeTokens, SCOPE } from '../security/scoped-tokens.js';
import { uiDir, type ModuleHost } from './host.js';
import { badgeOf } from './notify.js';

const DEFAULT_TTL_S = 15 * 60;
const MAX_TTL_S = 24 * 60 * 60;

/** The manifest's `coreEndpoints` that are well-formed scopes. */
export function coreEndpointsOf(manifest: Record<string, unknown>): string[] {
  const raw = manifest.coreEndpoints;
  return Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === 'string' && SCOPE.test(s))
    : [];
}

/** What a module UI's token reaches: its own routes, and what its manifest declares. */
export function moduleScopes(id: string, manifest: Record<string, unknown>): string[] {
  return [`* /api/modules/${id}/*`, ...coreEndpointsOf(manifest)];
}

export function mountModuleRoutes(app: Express, host: ModuleHost): void {
  app.get('/modules', (_req: Request, res: Response) => {
    res.json({
      modules: host.list().map((h) => ({
        id: h.module.id,
        name: h.module.manifest.name ?? h.module.id,
        version: h.module.manifest.version ?? null,
        dir: h.module.dir,
        status: h.status,
        error: h.error ?? null,
        coreEndpoints: coreEndpointsOf(h.module.manifest),
        ui: h.status === 'loaded' && uiDir(h.module.dir) ? `/api/modules/${h.module.id}/ui/` : null,
        triggers: host.triggers.list(h.module.id),
        badge: badgeOf(h.module.id),
      })),
    });
  });

  /**
   * A short-lived token for a module's UI: the desktop hands it to the module's
   * iframe. Default 15 minutes, at most 24 hours.
   */
  app.post('/modules/:id/token', (req: Request, res: Response) => {
    const hosted = host.get(String(req.params.id));
    if (!hosted || hosted.status !== 'loaded') {
      return res.status(404).json({ error: 'module_not_found', message: 'No such loaded module.' });
    }
    const body = (req.body ?? {}) as { ttlSeconds?: unknown };
    const ttl =
      typeof body.ttlSeconds === 'number' && body.ttlSeconds > 0
        ? Math.min(Math.floor(body.ttlSeconds), MAX_TTL_S)
        : DEFAULT_TTL_S;
    const scopes = moduleScopes(hosted.module.id, hosted.module.manifest);
    const { token, expiresAt } = issueToken({
      kind: 'module',
      subject: hosted.module.id,
      scopes,
      ttlMs: ttl * 1000,
    });
    res.status(201).json({ token, expiresAt, scopes });
  });

  /** Revoke every token issued for a module's UI. */
  app.delete('/modules/:id/tokens', (req: Request, res: Response) => {
    res.json({ ok: true, revoked: revokeTokens('module', String(req.params.id)) });
  });
}
