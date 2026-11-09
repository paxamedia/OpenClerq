// A module's server entry: one self-contained ES module, run inside the gateway.
// Written by hand here; a real module would bundle it from TypeScript with
// @clerq/module-sdk's types.

/** @type {import('@clerq/module-sdk').ClerqModule} */
export default {
  register(ctx) {
    ctx.routes.get('/hello', (req, res) => {
      const name = typeof req.query.name === 'string' ? req.query.name : 'world';
      res.json({ message: `${ctx.config.greeting}, ${name}` });
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
