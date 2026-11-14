/**
 * The skills routes.
 *
 *   GET  /skills                  every skill, with its trust state and what it declares
 *   GET  /skills/:slug            one skill: its manifest, instructions and trust state
 *   POST /skills/:slug/trust      { checksum }: trust the files as they are, if they are those
 *   POST /skills/:slug/block      never use this skill
 *   POST /skills/:slug/untrust    forget what was decided
 *
 * The three decisions are operator-only (security/scoped-tokens.ts): a module's or a phone's
 * token cannot trust a skill. `PUT /skills/:slug` (schemas and dependencies) is in gateway.ts.
 */

import type { Express, Request, Response } from 'express';
import { actorOf } from '../records/routes.js';
import { logger } from '../logger.js';
import { SkillError, type SkillCatalog, type SkillView } from './catalog.js';
import type { SkillNeeds } from '@clerq/plugin-sdk/skill';

/** What the API says of one skill. */
export interface SkillInfo {
  slug: string;
  name: string;
  description?: string;
  version?: string;
  agentHint?: 'primary' | 'fallback';
  triggers?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  dependsOn?: string[];
  /** Where it was found: `directory`, `module:<id>` or `plugin:<id>`. */
  origin: string;
  trust: 'untrusted' | 'trusted' | 'modified' | 'blocked';
  /** The trust state, in a sentence. */
  trustReason: string;
  /** Who vouches for it, when it is trusted: you, OpenClerq (a skill that ships with it) or its plugin. */
  trustedBy: 'user' | 'bundled' | 'plugin' | null;
  trustedAt: string | null;
  /** What its manifest declares it needs. */
  declared: SkillNeeds;
  /** The checksum its author wrote in SKILL.md; null when there is none. */
  checksum: string | null;
  /** The checksum of its files as they are now; null when they could not be hashed. */
  computedChecksum: string | null;
  /** Whether those are the same; null when there is no declared checksum or no computed one. */
  checksumMatches: boolean | null;
  warnings: string[];
  /** What differs from what was trusted or blocked; null when nothing was decided or it is the same. */
  changes: SkillView['changes'];
  /** The files the checksum covers. */
  files: Array<{ path: string; sha256: string; size: number }>;
  /** Why its files could not be hashed, when they could not. */
  problem: string | null;
}

export function skillInfo(v: SkillView): SkillInfo {
  const m = v.meta;
  return {
    slug: v.slug,
    name: v.name,
    ...(m.description !== undefined ? { description: m.description } : {}),
    ...(m.version !== undefined ? { version: m.version } : {}),
    ...(m.agentHint ? { agentHint: m.agentHint } : {}),
    ...(m.triggers ? { triggers: m.triggers } : {}),
    ...(m.inputSchema ? { inputSchema: m.inputSchema } : {}),
    ...(m.outputSchema ? { outputSchema: m.outputSchema } : {}),
    ...(m.dependsOn ? { dependsOn: m.dependsOn } : {}),
    origin: v.source,
    trust: v.state,
    trustReason: v.reason,
    trustedBy: v.trustedBy,
    trustedAt: v.trustedAt,
    declared: v.needs,
    checksum: v.declaredChecksum,
    computedChecksum: v.checksum,
    checksumMatches:
      v.declaredChecksum !== null && v.checksum !== null ? v.declaredChecksum === v.checksum : null,
    warnings: v.warnings,
    changes: v.changes,
    files: v.files,
    problem: v.problem,
  };
}

export function mountSkillRoutes(
  app: Express,
  catalog: SkillCatalog,
  deps: { enforcing(): boolean }
): void {
  const fail = (res: Response, e: unknown, fallback: string): Response => {
    if (e instanceof SkillError) {
      const status = { not_found: 404, stale: 409, not_trustable: 409, invalid: 400 }[e.code];
      const error = e.code === 'stale' ? 'trust_stale' : e.code;
      return res.status(status).json({ error, message: e.message });
    }
    logger.error('skills request failed', { err: e instanceof Error ? e.message : String(e) });
    return res.status(500).json({ error: fallback });
  };
  const slugOf = (req: Request): string =>
    typeof req.params?.slug === 'string' ? req.params.slug : '';

  app.get('/skills', async (_req: Request, res: Response) => {
    try {
      const views = await catalog.list();
      if (views.length === 0) {
        return res.json({
          skills: [
            {
              slug: 'example',
              name: 'Example',
              description:
                'Add skills in your skills directory. See skills/example for a template.',
              origin: 'directory',
              trust: 'untrusted',
              trustReason: 'This is a placeholder, not a skill on disk.',
              trustedBy: null,
              trustedAt: null,
              declared: { tools: [], domains: [], paths: [] },
              checksum: null,
              computedChecksum: null,
              checksumMatches: null,
              warnings: [],
              changes: null,
              files: [],
              problem: null,
            } satisfies SkillInfo,
          ],
          source: 'fallback',
          enforce: deps.enforcing(),
        });
      }
      res.json({
        skills: views.map(skillInfo),
        source: catalog.hasModuleSources() ? 'disk+modules' : 'disk',
        enforce: deps.enforcing(),
      });
    } catch (e) {
      fail(res, e, 'skills_load_failed');
    }
  });

  app.get('/skills/:slug', async (req: Request, res: Response) => {
    const slug = slugOf(req);
    if (!slug) return res.status(400).json({ error: 'slug required' });
    try {
      const view = await catalog.find(slug);
      if (!view) return res.status(404).json({ error: 'skill_not_found', slug });
      res.json({ meta: view.meta, body: view.body, skill: skillInfo(view) });
    } catch (e) {
      fail(res, e, 'skill_load_failed');
    }
  });

  app.post('/skills/:slug/trust', async (req: Request, res: Response) => {
    const slug = slugOf(req);
    const body = (req.body ?? {}) as { checksum?: unknown };
    if (typeof body.checksum !== 'string' || body.checksum.trim() === '') {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'Send the "checksum" of the skill as the list showed it (its computedChecksum).',
      });
    }
    try {
      const view = await catalog.trust(slug, body.checksum.trim(), actorOf(res));
      res.json({ skill: skillInfo(view) });
    } catch (e) {
      fail(res, e, 'skill_trust_failed');
    }
  });

  for (const action of ['block', 'untrust'] as const) {
    app.post(`/skills/:slug/${action}`, async (req: Request, res: Response) => {
      try {
        const view = await catalog[action](slugOf(req), actorOf(res));
        res.json({ skill: skillInfo(view) });
      } catch (e) {
        fail(res, e, `skill_${action}_failed`);
      }
    });
  }
}
