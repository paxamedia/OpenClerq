import { readTextFileWithin, PathContainmentError } from './security/paths.js';
import { safeFetch, NetworkPolicyError, type NetworkPolicy } from './security/network.js';

export interface ToolInvocation<TInput = unknown, TOutput = unknown> {
  name: string;
  input: TInput;
  output?: TOutput;
}

export interface ToolSpec<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  run: (input: TInput) => Promise<TOutput>;
}

export interface ToolConfig {
  /** Root directory for filesystem tools. Defaults to process.cwd(). */
  fsRoot?: string;
  /** Largest file fs.read will return, in bytes. Default: 1 MiB. */
  fsMaxReadBytes?: number;
  /** Allowed HTTP hostnames. When empty or unset, http.request is not registered. */
  httpAllowlist?: string[];
  /** URL schemes http.request may use. Default: https only. */
  httpAllowedSchemes?: string[];
  /** Largest response body retained, in bytes. Default: 256 KiB. */
  httpMaxBytes?: number;
  /** Whole-request timeout in milliseconds. Default: 10000. */
  httpTimeoutMs?: number;
  /** Permit private, loopback and link-local destinations. Default: false. */
  httpAllowPrivateAddresses?: boolean;
}

export interface ToolRegistry {
  list(): Array<{ name: string; description: string }>;
  run<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
}

const DEFAULT_FS_MAX_READ_BYTES = 1_048_576;

function createFsReadTool(
  config: ToolConfig
): ToolSpec<{ relativePath: string }, { path: string; content: string; bytes: number }> {
  const root = config.fsRoot || process.cwd();
  const maxBytes = config.fsMaxReadBytes ?? DEFAULT_FS_MAX_READ_BYTES;

  return {
    name: 'fs.read',
    description: 'Read a UTF-8 text file from within the configured root directory.',
    async run(input) {
      // Containment, symlink resolution and size limits all live in readTextFileWithin.
      return readTextFileWithin(root, input?.relativePath ?? '', maxBytes);
    },
  };
}

function createHttpRequestTool(
  config: ToolConfig
): ToolSpec<
  { method?: string; url: string; headers?: Record<string, string>; body?: string },
  { status: number; headers: Record<string, string>; bodyText: string; truncated: boolean; chain: string[] }
> | null {
  const allowlist = config.httpAllowlist ?? [];
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    // Disabled by default. No allowlist, no outbound HTTP.
    return null;
  }

  const policy: NetworkPolicy = {
    allowlist,
    allowedSchemes: config.httpAllowedSchemes,
    maxBytes: config.httpMaxBytes,
    timeoutMs: config.httpTimeoutMs,
    allowPrivateAddresses: config.httpAllowPrivateAddresses,
  };

  return {
    name: 'http.request',
    description:
      'Make an HTTP(S) request to an allow-listed host. Redirects are revalidated; private and loopback addresses are refused.',
    async run(input) {
      if (typeof input?.url !== 'string' || !input.url) {
        throw new NetworkPolicyError('http.request requires a non-empty url string.');
      }
      return safeFetch(
        input.url,
        { method: input.method, headers: input.headers, body: input.body },
        policy
      );
    },
  };
}

export function createToolRegistry(config: ToolConfig = {}): ToolRegistry {
  const tools: ToolSpec<any, any>[] = [];

  // Filesystem read tool (always enabled; read-only)
  tools.push(createFsReadTool(config));

  const httpTool = createHttpRequestTool(config);
  if (httpTool) tools.push(httpTool);

  const byName = new Map<string, ToolSpec<any, any>>();
  for (const t of tools) {
    byName.set(t.name, t);
  }

  return {
    list() {
      return tools.map((t) => ({ name: t.name, description: t.description }));
    },
    async run(name, input) {
      const tool = byName.get(name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return tool.run(input);
    },
  };
}

export { PathContainmentError, NetworkPolicyError };
