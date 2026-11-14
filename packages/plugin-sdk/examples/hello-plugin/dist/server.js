// A plugin's server entry: one self-contained ES module, run inside the gateway.
// Written by hand here; a real plugin would bundle it from TypeScript with
// @clerq/plugin-sdk's types.

// State lives in the module, reset by start(): the host imports this file once per version.
let startedAt = Date.now();
let beats = 0;

/** @type {import('@clerq/plugin-sdk').PluginDefinition} */
export default {
  // Called once at every start, after the plugin's migrations (it has none).
  register(ctx) {
    ctx.routes.get('/hello', (req, res) => {
      const name = typeof req.query.name === 'string' ? req.query.name : 'world';
      res.json({ message: `${ctx.config.greeting}, ${name}`, version: ctx.version });
    });

    // The value goes into the vault as `hello-plugin/token`: a name the manifest declares.
    ctx.routes.put('/token', (req, res) => {
      ctx.secrets.set('token', String(req.body?.value ?? ''));
      res.json({ ok: true });
    });
    ctx.routes.get('/token', (_req, res) => {
      res.json({ set: ctx.secrets.get('token') !== null });
    });

    // A call to a host the manifest declares (`net`). Another host would be refused
    // when the person has turned enforcement on, and audited either way.
    ctx.routes.get('/zen', async (_req, res) => {
      const answer = await ctx.fetch(String(ctx.config.zenUrl));
      res.json({ status: answer.status, zen: (await answer.text()).trim() });
    });

    // A secret the manifest does not declare. Allowed, and audited, while enforcement is
    // off; refused with a PluginPermissionError (and audited) while it is on.
    ctx.routes.get('/undeclared', (_req, res) => {
      res.json({ set: ctx.secrets.get('other') !== null });
    });

    // Each firing is a run in run history. Fire it with
    // POST /api/modules/hello-plugin/triggers/ping; its JSON body is the payload.
    ctx.triggers.register({
      id: 'ping',
      kind: 'webhook',
      description: 'Answers with how long the plugin has been running.',
      handler: () => ({ upSeconds: Math.round((Date.now() - startedAt) / 1000), beats }),
    });
  },

  // Called after register succeeded: begin work. The timer is the context's, so it is
  // cancelled for us when the plugin stops.
  start(ctx) {
    startedAt = Date.now();
    beats = 0;
    ctx.setInterval(() => {
      beats += 1;
    }, 60_000);
    ctx.logger.info('hello-plugin started');
  },

  // Called when the plugin is disabled or the gateway closes. What was registered through
  // the context (routes, triggers, timers, subscriptions) is removed after this returns.
  stop(ctx) {
    ctx.audit.append('stopped', undefined, { beats });
    ctx.logger.info('hello-plugin stopped');
  },

  // Called before register when the version differs from the one that last started.
  upgrade(ctx, { from }) {
    ctx.audit.append('upgraded', undefined, { from, to: ctx.version });
  },
};
