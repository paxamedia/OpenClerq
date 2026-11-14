/**
 * The gateway's API protocol version: the one definition the gateway, this
 * client, the CLI and plugins all use. See docs/API.md for the rules.
 *
 * This file has no imports and touches no runtime API, so the gateway can load
 * it as `@clerq/gateway-client/protocol` without pulling in the client.
 */

/**
 * The protocol version this build speaks. One integer. Within a version,
 * changes are additive only (new routes, new optional request fields, new
 * response fields, new event types); removing or renaming a route or a field,
 * changing a type, or changing a meaning needs the next version.
 */
export const API_VERSION = 1;

/** The versions a gateway built from this source serves, newest last. */
export const SUPPORTED_API_VERSIONS: readonly number[] = [API_VERSION];

/** Sent by clients on every request, and by the gateway on every response. */
export const API_VERSION_HEADER = 'Clerq-Api-Version';

/** `/v1`: every API route is served under it; the bare paths are aliases through 1.x. */
export function apiPrefix(version: number = API_VERSION): string {
  return `/v${version}`;
}

/** What `GET /version` answers. Nothing in it is secret or particular to one machine. */
export interface VersionInfo {
  /** The gateway's own release, e.g. "1.0.0". */
  gateway: string;
  api: {
    /** The version this gateway prefers and reports. */
    version: number;
    /** Every version it serves. */
    supported: number[];
  };
  store: {
    /** The newest core migration applied; null while the store is not open yet. */
    schema: number | null;
  };
}

/** The 400 body for a version the gateway does not serve, answered before auth. */
export interface UnsupportedApiVersion {
  error: 'unsupported_api_version';
  /** What the caller asked for, as it sent it (header text or path segment). */
  requested: string;
  supported: number[];
  message: string;
}

/** The 400 body when the path's `/vN` and the header name different versions. */
export interface ApiVersionMismatch {
  error: 'api_version_mismatch';
  /** The header's value and the path's version, as sent. */
  header: string;
  path: string;
  supported: number[];
  message: string;
}

/**
 * A version as written in a header or a path: digits, no sign, no leading
 * zero. Anything else is not a version and returns null.
 */
export function parseApiVersion(text: string): number | null {
  const t = text.trim();
  if (!/^[1-9]\d{0,8}$/.test(t)) return null;
  return Number(t);
}

/**
 * Plain words for "the gateway cannot serve what the app speaks", or an empty
 * string when `supported` includes `wanted`.
 */
export function incompatibilityReason(
  supported: readonly number[],
  wanted: number = API_VERSION
): string {
  if (supported.includes(wanted)) return '';
  const newest = supported.length > 0 ? Math.max(...supported) : 0;
  if (newest === 0) {
    return `This gateway does not say which API versions it speaks; this app needs API ${wanted}. Update the gateway.`;
  }
  return newest > wanted
    ? `This gateway speaks API ${newest}; this app needs API ${wanted}. Update the app or the gateway.`
    : `This gateway speaks API ${newest}; this app needs API ${wanted}. Update the gateway.`;
}
