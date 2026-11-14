# @clerq/plugin-sdk

The OpenClerq plugin contract: what a plugin's server code is given, the manifest it declares, the
lifecycle the gateway runs it through, the types of a UI that is part of the app, and the checksum
of its code. The reference is [docs/PLUGINS.md](../../docs/PLUGINS.md).

```ts
import { definePlugin } from '@clerq/plugin-sdk';

export default definePlugin({
  register(ctx) {
    ctx.routes.get('/hello', (_req, res) => res.json({ hello: ctx.id }));
  },
  start(ctx) {
    ctx.setInterval(() => ctx.logger.info('still here'), 60_000);
  },
});
```

| Import                       | What                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `@clerq/plugin-sdk`          | `definePlugin`, `PluginContext`, `PluginPermissions`, `PluginPermissionError`, `tablePrefix`   |
| `@clerq/plugin-sdk/manifest` | `validateManifest`, `engineProblem`, `describePermissions`, `diffPermissions` (pure)           |
| `@clerq/plugin-sdk/node`     | `pluginChecksum(dir)`, `permissionsHash(p)`, `readManifestFile(dir)`                           |
| `@clerq/plugin-sdk/ui`       | `PluginUI`, `PluginProps`, `RailEntry`, `PaletteCommand`, `GatewayClient`, `Host`, `AppConfig` |

A plugin runs inside the gateway process with the gateway's access. Enforcement, when the user turns
it on, checks what goes through the context; it is not a sandbox.

[`examples/hello-plugin`](examples/hello-plugin) is a complete plugin. `@clerq/module-sdk` re-exports
this package under the names it had, and keeps working through 1.x.
