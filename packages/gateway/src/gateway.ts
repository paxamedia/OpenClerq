import express, { Request, Response } from 'express';
import fssync from 'node:fs';
import type { Server } from 'node:http';
import type { GatewayConfig } from './types.js';
import { licenseCheck } from './middleware/license.js';
import { logger } from './logger.js';
import { getCalcBinaryPath, runEvalCalc } from './calc.js';
import { getSkillsDir, loadSkillsFromDir, loadSkillContent, saveSkillFrontmatter } from './skills-loader.js';
import { getExplanation, buildContextPreview } from './agent/explain.js';
import { getLLMProviderStatus, getAvailableModels } from './agent/llm-provider.js';
import { runTask } from './agent/task.js';
import { selectSkill } from './agent/skill-selector.js';
import { loadModulesFromDir, mountModuleRoutes, getModuleSkillsDirs } from './module-loader.js';
import { createToolRegistry } from './tools.js';
import { loadCapabilities, saveCapabilities, capabilitiesToToolConfig, type CapabilitiesConfig } from './capabilities.js';
import { loadReasoning, saveReasoning, type ReasoningConfig } from './reasoning-config.js';
import { loadSystemPrompt, saveSystemPrompt, DEFAULT_PROMPT } from './system-prompt.js';
import { getObservability } from './observability.js';
import { getLogBuffer, subscribe, type LogEntry } from './log-stream.js';
import { listSecrets, setSecret, deleteSecret } from './secrets-vault.js';
import { startTriggers, getTriggers, saveTriggers, getWebhookMessage, type TriggersConfig } from './triggers.js';
import { listMemory, getMemory, setMemory, deleteMemory } from './memory-layer.js';

const DEFAULT_PORT = 18790;

export function createGateway(config: GatewayConfig = {}): { app: express.Express; server: Server } {
  const port = config.port ?? DEFAULT_PORT;
  const devMode = config.devMode ?? (process.env.CLERQ_DEV === '1' || process.env.CLERQ_DEV === 'true');
  const skillsDir = config.skillsDir ?? getSkillsDir();
  const calcPath = config.calculationEnginePath ?? getCalcBinaryPath();
  const initialToolsConfig = config.toolsConfig ?? capabilitiesToToolConfig(loadCapabilities());
  let toolRegistry = createToolRegistry(initialToolsConfig);

  const app = express();
  let loadedModules: Awaited<ReturnType<typeof loadModulesFromDir>> = [];

  app.use((req, res, next) => {
    if (devMode) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      const origins = process.env.CLERQ_CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? [];
      const origin = req.headers.origin;
      if (origins.length > 0 && typeof origin === 'string' && origins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json());
  app.use(licenseCheck(devMode));

  app.get('/health', (_req, res) => {
    const llmStatus = getLLMProviderStatus();
    const llmMode = llmStatus.provider === 'anthropic' ? 'api' : 'local';
    res.json({
      status: 'ok',
      service: 'clerq-gateway',
      version: '0.1.0',
      llm: {
        mode: llmMode,
        provider: llmStatus.provider,
        model: llmStatus.model,
        available: llmStatus.available,
      },
    });
  });

  const startTime = Date.now();
  app.get('/models', async (_req, res) => {
    try {
      const [models, status] = await Promise.all([getAvailableModels(), Promise.resolve(getLLMProviderStatus())]);
      res.json({ models, current: status.model });
    } catch (e) {
      logger.error('models list error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'models_list_failed' });
    }
  });

  app.get('/secrets', (_req, res) => {
    const result = listSecrets();
    if (Array.isArray(result)) {
      res.json({ secrets: result });
    } else {
      res.status(503).json(result);
    }
  });

  app.post('/secrets', (req: Request, res: Response) => {
    const body = req.body as { name?: string; value?: string };
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const value = typeof body?.value === 'string' ? body.value : '';
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }
    const out = setSecret(name, value);
    if (out.ok) {
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: out.error });
    }
  });

  app.get('/capabilities', (_req, res) => {
    res.json(loadCapabilities());
  });

  app.get('/system-prompt', (_req, res) => {
    res.json({ prompt: loadSystemPrompt(), default: DEFAULT_PROMPT });
  });

  app.post('/system-prompt', (req: Request, res: Response) => {
    const body = req.body as { prompt?: string };
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    try {
      saveSystemPrompt(prompt);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed' });
    }
  });

  app.get('/reasoning', (_req, res) => {
    res.json(loadReasoning());
  });

  app.post('/reasoning', (req: Request, res: Response) => {
    const body = req.body as Partial<ReasoningConfig>;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid config' });
    }
    try {
      const current = loadReasoning();
      const c: ReasoningConfig = { ...current };
      if (body.temperature !== undefined) {
        c.temperature = typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2 ? body.temperature : undefined;
      }
      if (body.maxTokens !== undefined) {
        c.maxTokens = typeof body.maxTokens === 'number' && body.maxTokens >= 1 && body.maxTokens <= 128000 ? body.maxTokens : undefined;
      }
      saveReasoning(c);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed' });
    }
  });

  app.post('/capabilities', (req: Request, res: Response) => {
    const body = req.body as CapabilitiesConfig;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid config' });
    }
    try {
      const c: CapabilitiesConfig = {
        fsRoot: typeof body.fsRoot === 'string' ? body.fsRoot : undefined,
        fsAllowWrite: typeof body.fsAllowWrite === 'boolean' ? body.fsAllowWrite : undefined,
        httpAllowlist: Array.isArray(body.httpAllowlist)
          ? body.httpAllowlist.filter((h): h is string => typeof h === 'string')
          : undefined,
      };
      saveCapabilities(c);
      toolRegistry = createToolRegistry(capabilitiesToToolConfig(loadCapabilities()));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed' });
    }
  });

  app.delete('/secrets/:name', (req: Request, res: Response) => {
    const name = (typeof req.params?.name === 'string' ? req.params.name : '') || '';
    const out = deleteSecret(name);
    if (out.ok) {
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: out.error });
    }
  });

  app.get('/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    const send = (entry: LogEntry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    getLogBuffer().forEach(send);
    const unsub = subscribe(send);
    req.on('close', unsub);
  });

  app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({
      version: '0.1.0',
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      service: 'clerq-gateway',
      ...getObservability(),
    });
  });

  app.get('/tools', (_req, res) => {
    try {
      const tools = toolRegistry.list();
      res.json({ tools });
    } catch (e) {
      logger.error('tools list error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'tools_list_failed' });
    }
  });

  app.post('/tools/run', async (req: Request, res: Response) => {
    const body = req.body as { name?: string; input?: unknown };
    const name = body?.name;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'tool_name_required' });
    }
    try {
      const result = await toolRegistry.run(name, body.input);
      res.json({ name, result });
    } catch (e) {
      logger.error('tools run error', { name, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({
        error: 'tool_run_failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  });

  app.get('/skills', async (_req, res) => {
    try {
      const skills = await loadSkillsFromDir(skillsDir);
      const moduleSkillsDirs = getModuleSkillsDirs(loadedModules);
      for (const dir of moduleSkillsDirs) {
        const fromModule = await loadSkillsFromDir(dir);
        const seen = new Set(skills.map((s) => s.slug));
        for (const s of fromModule) {
          if (!seen.has(s.slug)) {
            seen.add(s.slug);
            skills.push(s);
          }
        }
      }
      if (skills.length === 0) {
        return res.json({
          skills: [
            { slug: 'example', name: 'Example', description: 'Add skills in your skills directory. See skills/example for a template.' },
          ],
          source: 'fallback',
        });
      }
      res.json({ skills, source: moduleSkillsDirs.length > 0 ? 'disk+modules' : 'disk' });
    } catch (e) {
      logger.error('skills load error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'skills_load_failed' });
    }
  });

  app.get('/skills/:slug', async (req: Request, res: Response) => {
    const slug = typeof req.params?.slug === 'string' ? req.params.slug : '';
    if (!slug) return res.status(400).json({ error: 'slug required' });
    try {
      const content = await loadSkillContent(skillsDir, slug);
      if (!content) return res.status(404).json({ error: 'skill_not_found', slug });
      res.json({ meta: content.meta, body: content.body });
    } catch (e) {
      logger.error('skill load error', { slug, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'skill_load_failed' });
    }
  });

  app.put('/skills/:slug', async (req: Request, res: Response) => {
    const slug = typeof req.params?.slug === 'string' ? req.params.slug : '';
    if (!slug) return res.status(400).json({ error: 'slug required' });
    const body = req.body as { inputSchema?: Record<string, unknown> | null; outputSchema?: Record<string, unknown> | null; dependsOn?: string[] | null };
    try {
      const ok = await saveSkillFrontmatter(skillsDir, slug, {
        inputSchema: body.inputSchema,
        outputSchema: body.outputSchema,
        dependsOn: body.dependsOn,
      });
      if (!ok) return res.status(404).json({ error: 'skill_not_found', slug });
      res.json({ ok: true });
    } catch (e) {
      logger.error('skill save error', { slug, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'skill_save_failed' });
    }
  });

  app.get('/memory', (_req, res) => {
    try {
      const entries = listMemory();
      res.json({ entries });
    } catch (e) {
      logger.error('memory list error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'memory_list_failed' });
    }
  });

  app.get('/memory/:key', (req: Request, res: Response) => {
    const key = typeof req.params?.key === 'string' ? req.params.key : '';
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      const entry = getMemory(key);
      if (!entry) return res.status(404).json({ error: 'memory_not_found', key });
      res.json(entry);
    } catch (e) {
      logger.error('memory get error', { key, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'memory_get_failed' });
    }
  });

  app.post('/memory', (req: Request, res: Response) => {
    const body = req.body as { key?: string; value?: unknown };
    const key = typeof body?.key === 'string' ? body.key.trim() : '';
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      setMemory(key, body.value);
      res.json({ ok: true });
    } catch (e) {
      logger.error('memory set error', { key, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'memory_set_failed' });
    }
  });

  app.delete('/memory/:key', (req: Request, res: Response) => {
    const key = typeof req.params?.key === 'string' ? req.params.key : '';
    if (!key) return res.status(400).json({ error: 'key required' });
    try {
      const ok = deleteMemory(key);
      if (!ok) return res.status(404).json({ error: 'memory_not_found', key });
      res.json({ ok: true });
    } catch (e) {
      logger.error('memory delete error', { key, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'memory_delete_failed' });
    }
  });

  app.post('/calculate/eval', async (req: Request, res: Response) => {
    if (!fssync.existsSync(calcPath)) {
      return res.status(503).json({
        error: 'calculation_engine_unavailable',
        message: 'Arithmetic engine not built. Run: pnpm build:core',
        path: calcPath,
      });
    }
    const body = req.body as { expression?: string; inputs?: Record<string, number>; spec?: { id?: string; formulas?: Record<string, string>; output_names?: string[] } };
    if (!body.expression && !body.spec?.formulas) {
      return res.status(400).json({ error: 'expression or spec.formulas required' });
    }
    try {
      const spec = body.spec?.formulas ? { ...body.spec, formulas: body.spec.formulas } : undefined;
      const result = await runEvalCalc(
        {
          expression: body.expression,
          inputs: body.inputs,
          spec,
        },
        calcPath
      );
      res.json(result);
    } catch (e) {
      logger.error('calc eval error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({
        error: 'calculation_failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  });

  app.post('/explain', async (req: Request, res: Response) => {
    const body = req.body as { question?: string; context?: Record<string, unknown>; model?: string };
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (!question) {
      return res.status(400).json({ error: 'question is required' });
    }
    try {
      const result = await getExplanation({
        question,
        context: body.context,
        model: typeof body.model === 'string' ? body.model : undefined,
      });
      res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('ANTHROPIC_API_KEY') || msg.includes('CLERQ_LLM_BASE_URL') || msg.includes('CLERQ_LLM_PROVIDER') || msg.includes('LLM request failed')) {
        return res.status(503).json({
          error: 'ai_unavailable',
          message: msg.slice(0, 200),
        });
      }
      logger.error('explain error', { err: msg });
      res.status(500).json({
        error: 'explain_failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  });

  app.post('/context/preview', (req: Request, res: Response) => {
    const body = req.body as { question?: string; context?: Record<string, unknown>; skillSlug?: string; skillName?: string };
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    try {
      const preview = buildContextPreview({
        question: question || '(no question)',
        context: body.context,
        skillSlug: body.skillSlug,
        skillName: body.skillName,
      });
      res.json(preview);
    } catch (e) {
      logger.error('context preview error', { err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'context_preview_failed' });
    }
  });

  app.post('/filing/prep', async (req: Request, res: Response) => {
    const body = req.body as { form_type?: string; data?: Record<string, unknown> };
    const formType = body.form_type ?? 'generic';
    const data = body.data ?? {};
    res.json({
      form_type: formType,
      draft: { ...data, _prepared_at: new Date().toISOString() },
      status: 'draft',
      note: 'Draft only; user submits manually.',
    });
  });

  app.post('/webhook/:id', async (req: Request, res: Response) => {
    const id = (typeof req.params?.id === 'string' ? req.params.id : '') || '';
    const message = getWebhookMessage(id);
    if (!message) {
      return res.status(404).json({ error: 'webhook not found' });
    }
    const body = req.body as { message?: string };
    const override = typeof body?.message === 'string' ? body.message.trim() : null;
    try {
      await runTaskFromContext(override || message, undefined);
      res.json({ ok: true });
    } catch (e) {
      logger.error('webhook task failed', { id, err: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ error: 'task_failed' });
    }
  });

  app.get('/triggers', (_req, res) => {
    res.json(getTriggers());
  });

  app.post('/triggers', (req: Request, res: Response) => {
    const body = req.body as TriggersConfig;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'invalid config' });
    }
    try {
      saveTriggers(body);
      startTriggers(runTaskFromContext);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed' });
    }
  });

  async function runTaskFromContext(message: string, model?: string, dryRun?: boolean) {
    let skills: Awaited<ReturnType<typeof loadSkillsFromDir>> = [];
    try {
      skills = await loadSkillsFromDir(skillsDir);
      const moduleSkillsDirs = getModuleSkillsDirs(loadedModules);
      for (const dir of moduleSkillsDirs) {
        const fromModule = await loadSkillsFromDir(dir);
        const seen = new Set(skills.map((s) => s.slug));
        for (const s of fromModule) {
          if (!seen.has(s.slug)) {
            seen.add(s.slug);
            skills.push(s);
          }
        }
      }
    } catch {
      // continue
    }
    const selection = selectSkill(message.trim(), skills);
    const runCalc =
      fssync.existsSync(calcPath) ?
        async (expression: string, inputs?: Record<string, number>) => {
          const r = await runEvalCalc({ expression, inputs: inputs ?? {} }, calcPath);
          return { values: r.values };
        }
      : undefined;
    return runTask({
      message: message.trim(),
      skillSlug: selection.skillSlug,
      skillName: selection.skill?.name,
      runCalc,
      model,
      dryRun,
    });
  }

  app.post('/task', async (req: Request, res: Response) => {
    const body = req.body as { message?: string; model?: string; dryRun?: boolean };
    const message = typeof body?.message === 'string' ? body.message : '';
    if (!message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }
    try {
      const result = await runTaskFromContext(
        message.trim(),
        typeof body.model === 'string' ? body.model : undefined,
        body.dryRun === true
      );
      logger.info('task', { skill: result.skillSlug ?? 'none' });
      res.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('ANTHROPIC_API_KEY') || msg.includes('CLERQ_LLM_BASE_URL') || msg.includes('CLERQ_LLM_PROVIDER') || msg.includes('LLM request failed')) {
        return res.status(503).json({
          error: 'ai_unavailable',
          message: msg.slice(0, 200),
        });
      }
      logger.error('task error', { err: msg });
      res.status(500).json({
        error: 'task_failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    }
  });

  const server = app.listen(port, async () => {
    logger.info('Gateway started', { port, url: `http://127.0.0.1:${port}` });
    startTriggers(runTaskFromContext);
    if (!devMode && !process.env.CLERQ_LICENSE) {
      logger.warn('No CLERQ_LICENSE set; non-health requests will get 403. Set CLERQ_DEV=1 for development.');
    }
    try {
      const modules = await loadModulesFromDir(config.modulesDir ?? process.env.CLERQ_MODULES_DIR);
      loadedModules = modules;
      if (modules.length > 0) {
        for (const mod of modules) {
          if (mod.routeHandlers.length > 0) {
            mountModuleRoutes(app, mod);
          } else {
            logger.info('Module loaded', { moduleId: mod.id, routes: 0 });
          }
        }
      }
    } catch (e) {
      logger.warn('Module load error', { err: e instanceof Error ? e.message : String(e) });
    }
  });

  return { app, server };
}
