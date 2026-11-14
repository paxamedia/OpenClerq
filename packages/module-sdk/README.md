# @clerq/module-sdk

**Superseded by [`@clerq/plugin-sdk`](../plugin-sdk).** Every type and helper that lived here now lives
there, and this package re-exports them under the names they always had (`ModuleContext`,
`ClerqModule`, `defineModule`, `ModulePermissions`, `tablePrefix`, …). A module written against it
compiles and loads unchanged, and it **keeps working through 1.x**: a manifest without
`manifestVersion` is a _legacy module_ and loads as it always did.

For new work use `@clerq/plugin-sdk`, which adds the v1 manifest, the lifecycle hooks (`upgrade`,
`start`, `stop`), the checked helpers (`ctx.exec`, `ctx.fetch`, `ctx.fs`), timers and the UI types.
See [docs/PLUGINS.md](../../docs/PLUGINS.md) for the reference, and
[docs/MODULE_SYSTEM.md](../../docs/MODULE_SYSTEM.md) for the module contract itself.

[`examples/hello-world`](examples/hello-world) is the legacy example.
