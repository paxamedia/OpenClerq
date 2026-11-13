/**
 * HTTP endpoints for model routing: the default chain managed chat and tasks
 * fall back along when the default model is unavailable.
 */

import type { Express, Request, Response } from 'express';
import { getLLMProviderStatus, getRegistry } from './agent/llm-provider.js';
import { logger } from './logger.js';
import {
  getDefaultFallback,
  MAX_DEFAULT_FALLBACK,
  RoutingError,
  setDefaultFallback,
} from './routing.js';

export function mountRoutingRoutes(app: Express): void {
  app.get('/routing', (_req: Request, res: Response) => {
    try {
      const status = getLLMProviderStatus();
      res.json({
        default: { provider: status.provider, model: status.model },
        fallback: getDefaultFallback(),
        maxFallback: MAX_DEFAULT_FALLBACK,
      });
    } catch (e) {
      logger.error('routing read error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'routing_read_failed' });
    }
  });

  /**
   * Set the models used, in order, when the default model is unavailable. A
   * call that names a model of its own never uses them. An empty list turns
   * the chain off.
   */
  app.put('/routing', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { fallback?: unknown };
      res.json({ fallback: setDefaultFallback(body.fallback, getRegistry()) });
    } catch (e) {
      if (e instanceof RoutingError) {
        return res.status(400).json({ error: 'invalid_routing', message: e.message });
      }
      logger.error('routing save error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'routing_save_failed' });
    }
  });
}
