// A module's server entry: one self-contained ES module, run inside the gateway.
// Written by hand here; a real module would bundle it from TypeScript with
// @clerq/module-sdk's types.

/** @type {import('@clerq/module-sdk').ClerqModule} */
export default {
  register(ctx) {
    // mod_hello_world__greetings, seen through the current tenant: the gateway
    // adds tenant_id to every module table and these helpers filter on it.
    const greetings = ctx.store.rows('greetings');

    ctx.routes.get('/hello', (req, res) => {
      const name = typeof req.query.name === 'string' ? req.query.name : 'world';
      res.json({ message: `${ctx.config.greeting}, ${name}` });
    });

    // Remembers who was greeted, in the module's own table (migrations/0001_greetings.sql).
    ctx.routes.post('/greetings', (req, res) => {
      const name = String(req.body?.name ?? 'world');
      const { id: lastInsertRowid } = greetings.insert({
        name,
        created_at: new Date().toISOString(),
      });
      // With an email, the greeting attaches to the shared person record that
      // every module sees, and shows on that person's activity timeline.
      if (typeof req.body?.email === 'string') {
        const { record } = ctx.records.resolve('person', { name, emails: [req.body.email] });
        const greeting = ctx.records.ref('greeting', String(lastInsertRowid));
        ctx.records.link(greeting, record.ref, 'greeted');
        ctx.records.addActivity({
          kind: 'greeting',
          summary: `Greeted ${name}`,
          refs: [record.ref],
        });
        // Something for a person to do, in the one inbox.
        ctx.inbox.add({
          kind: 'task',
          title: `Follow up with ${name}`,
          ref: record.ref,
          link: `/?greeting=${lastInsertRowid}`,
          externalId: `greeting-${lastInsertRowid}`,
        });
      }
      // On the bus as module.hello-world.greeted, so GET /events/stream shows it.
      ctx.events.emit('greeted', { name });
      ctx.notify.badge(String(greetings.count()));
      ctx.notify({ title: `Greeted ${name}`, link: '/' });
      res.status(201).json({ message: `${ctx.config.greeting}, ${name}` });
    });
    ctx.routes.get('/greetings', (_req, res) => {
      res.json({
        greetings: greetings
          .find({}, { orderBy: 'id' })
          .map(({ name, created_at }) => ({ name, created_at })),
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

    // Each firing is a run in run history. Fire this one with
    // POST /api/modules/hello-world/triggers/count; its JSON body is the payload.
    ctx.triggers.register({
      id: 'count',
      kind: 'webhook',
      description: 'Counts the greetings so far.',
      handler(event) {
        if (event.payload?.fail) throw new Error('Asked to fail.');
        return { greetings: greetings.count() };
      },
    });
    ctx.triggers.register({
      id: 'nightly',
      kind: 'cron',
      schedule: '0 3 * * *',
      description: 'Logs a line at three every morning.',
      handler: () => ctx.logger.info('hello-world nightly'),
    });

    ctx.inbox.onRespond((item, response) => {
      if (item.ref) {
        ctx.records.addActivity({
          kind: 'note',
          summary: response.text ?? 'Followed up',
          refs: [item.ref],
        });
      }
      return { noted: true };
    });

    // Asks the person first; the request waits in the approvals inbox.
    ctx.routes.post('/approval', async (req, res) => {
      const { id } = await ctx.approvals.request({
        action: 'demo',
        reason: String(req.body?.reason ?? 'A demonstration approval.'),
        tier: 'low',
      });
      res.status(202).json({ approvalId: id });
    });

    // Global search: greetings by name.
    ctx.search.register((q, { limit }) =>
      // Raw SQL filters on the tenant itself.
      ctx.store
        .prepare(
          `SELECT id, name FROM ${greetings.name}
           WHERE tenant_id = ? AND name LIKE ? ORDER BY id DESC LIMIT ?`
        )
        .all(ctx.tenant, `%${q}%`, limit)
        .map((g) => ({
          ref: ctx.records.ref('greeting', String(g.id)),
          title: `Greeting for ${g.name}`,
          path: `/?greeting=${g.id}`,
        }))
    );

    ctx.logger.info('hello-world registered');
  },
};
