/**
 * @clerq/module-sdk: superseded by `@clerq/plugin-sdk`, which holds every type
 * and helper that was here. This package re-exports them under their old names
 * (`ModuleContext`, `ClerqModule`, `defineModule`, `ModulePermissions`, …), so a
 * module written against it compiles and loads unchanged. It keeps working
 * through 1.x. New code should import from `@clerq/plugin-sdk`.
 */

export * from '@clerq/plugin-sdk';
