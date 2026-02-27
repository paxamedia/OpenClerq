import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

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
  /** Whether filesystem write operations are allowed. Defaults to false. */
  fsAllowWrite?: boolean;
  /** Allowed HTTP hostnames for http.request tool. When unset, http.request is disabled. */
  httpAllowlist?: string[];
}

export interface ToolRegistry {
  list(): Array<{ name: string; description: string }>;
  run<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
}

function createFsReadTool(config: ToolConfig): ToolSpec<{ relativePath: string }, { path: string; content: string }> {
  const root = path.resolve(config.fsRoot || process.cwd());

  return {
    name: 'fs.read',
    description: 'Read a UTF-8 text file from within the configured root directory.',
    async run(input) {
      const rel = input?.relativePath ?? '';
      if (typeof rel !== 'string' || !rel) {
        throw new Error('fs.read requires a non-empty relativePath string');
      }
      const resolved = path.resolve(root, rel);
      if (!resolved.startsWith(root)) {
        throw new Error('fs.read: access outside configured root is not allowed');
      }
      const content = await fs.promises.readFile(resolved, 'utf8');
      return { path: resolved, content };
    },
  };
}

function createHttpRequestTool(
  config: ToolConfig
): ToolSpec<
  { method?: string; url: string; headers?: Record<string, string>; body?: string },
  { status: number; headers: Record<string, string>; bodyText: string }
> | null {
  const allowlist = config.httpAllowlist ?? [];
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    // Disabled by default for safety.
    return null;
  }

  return {
    name: 'http.request',
    description: 'Make an HTTP(S) request to allowed hostnames (configured via httpAllowlist).',
    async run(input) {
      const url = input?.url;
      if (typeof url !== 'string' || !url) {
        throw new Error('http.request requires a non-empty url string');
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error('http.request: invalid URL');
      }
      const host = parsed.hostname.toLowerCase();
      const allowed = allowlist.map((h) => h.toLowerCase().trim());
      if (!allowed.includes(host)) {
        throw new Error(`http.request: host "${host}" is not in httpAllowlist`);
      }

      const method = (input.method || 'GET').toUpperCase();
      const headers = input.headers ?? {};
      const res = await fetch(url, {
        method,
        headers,
        body: input.body,
      });
      const bodyText = await res.text();
      const outHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });
      return {
        status: res.status,
        headers: outHeaders,
        bodyText,
      };
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

