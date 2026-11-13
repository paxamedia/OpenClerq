/**
 * HTTP endpoints for memory.
 *
 * The pre-2.0 endpoints (`GET /memory`, `GET /memory/:key`, `POST /memory`,
 * `DELETE /memory/:key`) answer as they always have, with the record's other
 * fields added to what they return. The records themselves, search, summarising
 * and the read policy are under `/memory/records`, `/memory/search`,
 * `/memory/consolidate` and `/memory/policy`; a key named `search`, `records`,
 * `consolidate` or `policy` is reached with `GET /memory?key=`.
 */

import type { Express, Request, Response } from 'express';
import { MEMORY_TYPES, isMemoryType, type MemoryType } from '@clerq/policy';
import { chat } from './agent/llm-provider.js';
import { logger } from './logger.js';
import {
  MemoryError,
  addRecord,
  consolidate,
  deleteMemory,
  deleteRecord,
  getMemory,
  getRecord,
  listMemory,
  listRecords,
  searchRecords,
  setMemory,
  unconsolidate,
  updateRecord,
  type ConsolidationInput,
  type Summariser,
} from './memory-layer.js';
import { getMemoryPolicy, setMemoryPolicy } from './memory-context.js';
import { recordRun } from './runs.js';

function fail(res: Response, e: unknown, code: string): Response {
  if (e instanceof MemoryError) {
    const status = e.code === 'invalid_memory' ? 400 : e.code === 'memory_not_found' ? 404 : 409;
    return res.status(status).json({ error: e.code, message: e.message });
  }
  if ((e as { code?: unknown })?.code === 'provider_error') {
    return res.status(503).json({
      error: 'ai_unavailable',
      message: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    });
  }
  const message = e instanceof Error ? e.message : String(e);
  logger.error(code, { err: message });
  return res.status(500).json({ error: code, message });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** `?type=` as a memory type, undefined when absent, and a MemoryError when it is not one. */
function typeParam(v: unknown): MemoryType | undefined {
  const t = str(v);
  if (t === undefined) return undefined;
  if (!isMemoryType(t)) {
    throw new MemoryError('invalid_memory', `type must be one of ${MEMORY_TYPES.join(', ')}.`);
  }
  return t;
}

function numberParam(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Over HTTP a record is a person's or an agent's: the other origins are the gateway's own. */
function originParam(v: unknown): 'user' | 'agent' | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v !== 'user' && v !== 'agent') {
    throw new MemoryError('invalid_memory', 'origin must be "user" or "agent".');
  }
  return v;
}

const SUMMARY_SYSTEM =
  'You merge saved notes into one. Reply with the merged note only, as plain text, with no preamble.';

/** Ask a model to fold the records of one key into one. */
function modelSummariser(model: string | undefined): Summariser {
  return async ({ key, type, records }: ConsolidationInput) => {
    const notes = records
      .map((r, i) => {
        const text = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
        return `[${i + 1}] (${r.createdAt.slice(0, 10)}) ${text}`;
      })
      .join('\n');
    const prompt =
      `These ${records.length} saved notes are all about "${key}" (kind: ${type}), oldest first.\n` +
      'Merge them into one note. Keep every distinct fact, drop repetition, and where two notes ' +
      'disagree prefer the newer. Write at most 1500 characters.\n\n' +
      notes;
    // A model a person named is used as chosen; otherwise the default may fall back.
    const res = await chat({
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      model,
      maxTokens: 1_024,
      temperature: 0.2,
    });
    return { text: res.text, model: `${res.provider}/${res.model}` };
  };
}

export function mountMemoryRoutes(app: Express): void {
  // --- Search and policy --------------------------------------------------

  app.get('/memory/search', (req: Request, res: Response) => {
    try {
      const q = str(req.query?.q);
      if (!q) throw new MemoryError('invalid_memory', 'q is required.');
      const types = str(req.query?.types)
        ?.split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (types && !types.every(isMemoryType)) {
        throw new MemoryError('invalid_memory', `types must be from ${MEMORY_TYPES.join(', ')}.`);
      }
      const { hits, mode } = searchRecords(q, {
        types: types as MemoryType[] | undefined,
        limit: numberParam(req.query?.limit),
      });
      res.json({ query: q, mode, results: hits });
    } catch (e) {
      fail(res, e, 'memory_search_failed');
    }
  });

  app.get('/memory/policy', (_req: Request, res: Response) => {
    try {
      res.json({ ...getMemoryPolicy(), types: [...MEMORY_TYPES] });
    } catch (e) {
      fail(res, e, 'memory_policy_failed');
    }
  });

  app.put('/memory/policy', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { readTypes?: unknown };
      res.json({ ...setMemoryPolicy(body.readTypes), types: [...MEMORY_TYPES] });
    } catch (e) {
      fail(res, e, 'memory_policy_failed');
    }
  });

  // --- Records --------------------------------------------------------------

  app.get('/memory/records', (req: Request, res: Response) => {
    try {
      const status = str(req.query?.status) ?? 'active';
      if (status !== 'active' && status !== 'superseded' && status !== 'all') {
        throw new MemoryError('invalid_memory', 'status must be active, superseded or all.');
      }
      res.json({
        records: listRecords({
          type: typeParam(req.query?.type),
          key: str(req.query?.key),
          status,
          includeExpired: req.query?.includeExpired === 'true',
          limit: numberParam(req.query?.limit),
          offset: numberParam(req.query?.offset),
        }),
      });
    } catch (e) {
      fail(res, e, 'memory_list_failed');
    }
  });

  app.post('/memory/records', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const record = addRecord({
        type: b.type,
        key: b.key,
        value: b.value,
        confidence: b.confidence,
        expiresAt: b.expiresAt,
        sourceSession: str(b.sourceSession),
        origin: originParam(b.origin),
      });
      res.status(201).json({ record });
    } catch (e) {
      fail(res, e, 'memory_set_failed');
    }
  });

  app.get('/memory/records/:id', (req: Request, res: Response) => {
    try {
      const record = getRecord(String(req.params.id));
      if (!record) return res.status(404).json({ error: 'memory_not_found', id: req.params.id });
      res.json({ record });
    } catch (e) {
      fail(res, e, 'memory_get_failed');
    }
  });

  app.patch('/memory/records/:id', (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json({
        record: updateRecord(String(req.params.id), {
          key: b.key,
          type: b.type,
          // `value: null` is a value; only an absent field leaves it as it is.
          ...('value' in b ? { value: b.value } : {}),
          confidence: b.confidence,
          expiresAt: b.expiresAt,
        }),
      });
    } catch (e) {
      fail(res, e, 'memory_set_failed');
    }
  });

  app.delete('/memory/records/:id', (req: Request, res: Response) => {
    try {
      if (!deleteRecord(String(req.params.id))) {
        return res.status(404).json({ error: 'memory_not_found', id: req.params.id });
      }
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, 'memory_delete_failed');
    }
  });

  // --- Summarising ------------------------------------------------------------

  /**
   * Fold the records of one key into a single record, written by a model.
   * The records are kept, `superseded`, and can be restored.
   */
  app.post('/memory/consolidate', async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as { key?: unknown; type?: unknown; model?: unknown };
      if (b.model !== undefined && typeof b.model !== 'string') {
        throw new MemoryError('invalid_memory', 'model must be a model name.');
      }
      const key = str(b.key);
      // The model call is a run of its own, so what it cost is on the record.
      const result = await recordRun(
        { trigger: 'manual', message: `Summarise memory: ${key ?? ''}` },
        () => consolidate({ key: b.key, type: b.type }, modelSummariser(str(b.model)))
      );
      res.json(result);
    } catch (e) {
      fail(res, e, 'memory_consolidate_failed');
    }
  });

  app.post('/memory/records/:id/unconsolidate', (req: Request, res: Response) => {
    try {
      res.json(unconsolidate(String(req.params.id)));
    } catch (e) {
      fail(res, e, 'memory_consolidate_failed');
    }
  });

  // --- The pre-2.0 endpoints ------------------------------------------------------

  app.get('/memory', (req: Request, res: Response) => {
    try {
      res.json({
        entries: listMemory({
          type: typeParam(req.query?.type),
          key: str(req.query?.key),
          limit: numberParam(req.query?.limit),
        }),
      });
    } catch (e) {
      fail(res, e, 'memory_list_failed');
    }
  });

  app.get('/memory/:key', (req: Request, res: Response) => {
    const key = typeof req.params?.key === 'string' ? req.params.key : '';
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      const entry = getMemory(key, typeParam(req.query?.type));
      if (!entry) return res.status(404).json({ error: 'memory_not_found', key });
      res.json(entry);
    } catch (e) {
      fail(res, e, 'memory_get_failed');
    }
  });

  /** Set a key: the newest record of that key and type is updated, or one is made. */
  app.post('/memory', (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const key = typeof b.key === 'string' ? b.key.trim() : '';
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      const record = setMemory(key, b.value, {
        type: b.type,
        confidence: b.confidence,
        expiresAt: b.expiresAt,
        sourceSession: str(b.sourceSession),
        origin: originParam(b.origin),
      });
      res.json({ ok: true, record });
    } catch (e) {
      fail(res, e, 'memory_set_failed');
    }
  });

  /** Forget a key: every record under it, summaries and the records behind them too. */
  app.delete('/memory/:key', (req: Request, res: Response) => {
    const key = typeof req.params?.key === 'string' ? req.params.key : '';
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      if (!deleteMemory(key)) return res.status(404).json({ error: 'memory_not_found', key });
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, 'memory_delete_failed');
    }
  });
}
