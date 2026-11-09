// A module's server entry: one self-contained ES module, run inside the gateway.
// Written by hand here; a real module would bundle it from TypeScript with
// @clerq/module-sdk's types.

/** @type {import('@clerq/module-sdk').ClerqModule} */
export default {
  register(ctx) {
    const greetings = ctx.store.table('greetings'); // mod_hello_world_greetings

    ctx.routes.get('/hello', (req, res) => {
      const name = typeof req.query.name === 'string' ? req.query.name : 'world';
      res.json({ message: `${ctx.config.greeting}, ${name}` });
    });

    // Remembers who was greeted, in the module's own table (migrations/0001_greetings.sql).
    ctx.routes.post('/greetings', (req, res) => {
      const name = String(req.body?.name ?? 'world');
      ctx.store
        .prepare(`INSERT INTO ${greetings} (name, created_at) VALUES (?, ?)`)
        .run(name, new Date().toISOString());
      // On the bus as module.hello-world.greeted, so GET /events/stream shows it.
      ctx.events.emit('greeted', { name });
      res.status(201).json({ message: `${ctx.config.greeting}, ${name}` });
    });
    ctx.routes.get('/greetings', (_req, res) => {
      res.json({
        greetings: ctx.store.prepare(`SELECT name, created_at FROM ${greetings} ORDER BY id`).all(),
      });
    });

    // The value goes into the vault as `hello-world/token`; only whether it is set comes back.
    ctx.routes.put('/token', (req, res) => {
      ctx.secrets.set('token', String(req.body?.value ?? ''));
      ctx.audit.append('token.set');
      res.json({ ok: true });
    });
    ctx.routes.get('/token', (_req, res) => {
      res.json({ set: ctx.secrets.get('token') !== null, names: ctx.secrets.list() });
    });

    ctx.logger.info('hello-world registered');
  },
};
