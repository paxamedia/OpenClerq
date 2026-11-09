/**
 * Tenants. One gateway can hold several tenants' data (a hosted multi-tenant
 * CRM) or just one (a gateway per client); a single-tenant install only ever
 * sees `default` and behaves as if tenants did not exist.
 *
 * The tenant travels with the async call chain: a request runs in the tenant
 * its token is bound to (or, for the gateway token, the one named by the
 * `X-Clerq-Tenant` header), and background work runs in `default` unless it
 * says otherwise with runInTenant.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_TENANT = 'default';
export const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const storage = new AsyncLocalStorage<string>();

export function currentTenant(): string {
  return storage.getStore() ?? DEFAULT_TENANT;
}

export function runInTenant<T>(tenantId: string, fn: () => T): T {
  if (!TENANT_ID.test(tenantId)) throw new Error(`Invalid tenant id "${tenantId}".`);
  return storage.run(tenantId, fn);
}
