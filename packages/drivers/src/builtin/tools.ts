/**
 * The builtin agent's tools: repository work inside the run's worktree.
 *
 * Each tool has two names. The model sees a plain one (`read_file`), because
 * both vendors limit tool names to letters, digits, `_` and `-`. Policy, run
 * steps and `agent.allowed_tools` use the OpenClerq one (`fs.read`), whose
 * prefix is the policy group.
 *
 * Every path is resolved inside the worktree by the same canonical check the
 * gateway's own `fs.read` uses: no absolute paths, no `..` out of the root,
 * no symlink that leads outside it. Commands run through the sandbox, as a
 * process group that is stopped when the command ends, with a time limit and
 * an output cap.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolDescriptor } from '@clerq/policy';
import { exec, resolveWithinRoot, type SandboxSpec } from '@clerq/sandbox';
import { truncateOutput, type ToolDefinition } from '@clerq/providers';
import type { SpawnedProcess } from '../types.js';

export interface ToolContext {
  /** The worktree. Every path is relative to it. */
  cwd: string;
  signal: AbortSignal;
  /** Epoch ms after which nothing new may start. */
  deadline: number;
  sandbox: Pick<SandboxSpec, 'profile' | 'network' | 'allowWrite' | 'image'>;
  /** Plain environment for commands: PATH and nothing secret. */
  env: Record<string, string>;
  /** A command a tool started, and a function to call when it has ended. */
  onProcess?: (process: SpawnedProcess) => () => void;
  /** Isolation warnings from the sandbox, collected for the run's result. */
  warnings?: Set<string>;
  /** The tool call being run, for a tool that reports it onward (`sessions.spawn`). */
  toolCallId?: string;
  /** Start a sub-agent and wait for its answer. Absent when the run cannot. */
  spawn?: (
    request: { task: string; tools?: string[]; model?: string },
    toolCallId: string
  ) => Promise<ToolOutcome>;
}

export interface ToolOutcome {
  output: string;
  isError: boolean;
}

export interface BuiltinTool {
  /** OpenClerq's name: what policy, steps and allowed_tools use. */
  name: string;
  risk: ToolDescriptor['risk'];
  definition: ToolDefinition;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Characters of one tool result the model is given. */
export const MAX_RESULT_CHARS = 30_000;
/** Lines `read_file` returns when no limit is given. */
const DEFAULT_READ_LINES = 400;
/** Largest file `read_file` will open. */
const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_LIST_ENTRIES = 1_000;
const DEFAULT_SHELL_SECONDS = 120;
const MAX_SHELL_SECONDS = 1_800;

export class ToolInputError extends Error {}

function str(input: Record<string, unknown>, key: string, required: true): string;
function str(input: Record<string, unknown>, key: string, required?: false): string | undefined;
function str(input: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = input[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolInputError(`"${key}" is required.`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolInputError(`"${key}" must be a string.`);
  return v;
}

function int(
  input: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ToolInputError(`"${key}" must be a whole number from ${min} to ${max}.`);
  }
  return v;
}

/** A path inside the worktree. "." and "" mean the worktree itself. */
function within(cwd: string, rel: string | undefined): string {
  const p = (rel ?? '.').trim();
  if (p === '' || p === '.' || p === './') return fs.realpathSync.native(cwd);
  return resolveWithinRoot(cwd, p);
}

function relative(cwd: string, abs: string): string {
  return path.relative(fs.realpathSync.native(cwd), abs) || '.';
}

const { O_WRONLY, O_CREAT, O_EXCL, O_TRUNC } = fs.constants;
/** Not on Windows, where there is nothing to refuse it for in the same way. */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/**
 * Write a file the containment check has resolved, without following a link
 * at its last step: a link planted after the check is refused (ELOOP), not
 * followed. A new file is created exclusively, so one that appears in between
 * is not overwritten.
 */
async function writeContained(abs: string, content: string, create: boolean): Promise<void> {
  const flags = O_WRONLY | O_NOFOLLOW | (create ? O_CREAT | O_EXCL : O_TRUNC);
  const handle = await fs.promises.open(abs, flags, 0o666);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

/** Run a command in the worktree through the sandbox. */
async function command(
  ctx: ToolContext,
  file: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; out: string; timedOut: boolean; cancelled: boolean }> {
  const wallMs = Math.max(1_000, Math.min(timeoutMs, ctx.deadline - Date.now()));
  let ended: (() => void) | undefined;
  try {
    const r = await exec(
      {
        profile: ctx.sandbox.profile ?? 'native',
        network: ctx.sandbox.network,
        allowWrite: ctx.sandbox.allowWrite,
        image: ctx.sandbox.image,
        cwd: ctx.cwd,
        env: ctx.env,
        limits: { wallMs, maxOutputBytes: 1_048_576 },
      },
      file,
      args,
      {
        signal: ctx.signal,
        onSpawn: ctx.onProcess
          ? (spawned) => {
              ended = ctx.onProcess?.({ ...spawned, command: file });
            }
          : undefined,
        // A server the agent started would otherwise outlive the command.
        reapGroup: true,
      }
    );
    for (const w of r.warnings) ctx.warnings?.add(w);
    const out = [r.stdout, r.stderr ? `${r.stdout ? '\n' : ''}[stderr]\n${r.stderr}` : '']
      .join('')
      .trimEnd();
    return {
      code: r.code,
      out: r.truncated ? `${out}\n[output cut at 1 MiB]` : out,
      timedOut: r.timedOut,
      cancelled: r.cancelled,
    };
  } finally {
    ended?.();
  }
}

const readFile: BuiltinTool = {
  name: 'fs.read',
  risk: 'read',
  definition: {
    name: 'read_file',
    description:
      'Read a text file in the repository, with line numbers. Long files come back a page at a time: ' +
      'pass offset (the first line, from 1) and limit (how many lines) to read further.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the repository root.' },
        offset: { type: 'integer', description: 'First line to return, from 1. Default 1.' },
        limit: { type: 'integer', description: `Lines to return. Default ${DEFAULT_READ_LINES}.` },
      },
      required: ['path'],
    },
  },
  async run(input, ctx) {
    const rel = str(input, 'path', true);
    const abs = within(ctx.cwd, rel);
    const stat = await fs.promises.stat(abs);
    if (!stat.isFile()) return { output: `${rel} is not a file.`, isError: true };
    if (stat.size > MAX_READ_BYTES) {
      return {
        output: `${rel} is ${stat.size} bytes, over the ${MAX_READ_BYTES}-byte limit. Use search_files or run_shell (head, sed -n) to read part of it.`,
        isError: true,
      };
    }
    const buf = await fs.promises.readFile(abs);
    if (buf.subarray(0, 8_000).includes(0)) {
      return { output: `${rel} looks binary (${stat.size} bytes); not shown.`, isError: true };
    }
    const lines = buf.toString('utf8').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const offset = int(input, 'offset', 1, Number.MAX_SAFE_INTEGER) ?? 1;
    const limit = int(input, 'limit', 1, 5_000) ?? DEFAULT_READ_LINES;
    if (lines.length === 0) return { output: `${rel} is empty.`, isError: false };
    if (offset > lines.length) {
      return {
        output: `${rel} has ${lines.length} lines; offset ${offset} is past the end.`,
        isError: true,
      };
    }
    const end = Math.min(lines.length, offset - 1 + limit);
    const width = String(end).length;
    const numbered = (i: number) => `${String(i + 1).padStart(width)}\t${lines[i]}`;
    // Whole lines only, up to the result cap, so "read on" starts where this page stopped.
    let body = '';
    let shown = offset - 1;
    for (let i = offset - 1; i < end; i++) {
      const line = numbered(i);
      if (body && body.length + 1 + line.length > MAX_RESULT_CHARS) break;
      body = body ? `${body}\n${line}` : line;
      shown = i + 1;
    }
    // A single line over the cap (a minified file) is shown in part.
    body = truncateOutput(body, {
      maxChars: MAX_RESULT_CHARS,
      tailShare: 0,
      hint: `Line ${shown} is too long to show whole; use run_shell (cut -c or head -c) for the rest.`,
    }).text;
    const more =
      shown < lines.length
        ? `\n[Lines ${offset}-${shown} of ${lines.length}. Read with offset ${shown + 1} to see more.]`
        : '';
    return { output: `${body}${more}`, isError: false };
  },
};

const listFiles: BuiltinTool = {
  name: 'fs.list',
  risk: 'read',
  definition: {
    name: 'list_files',
    description:
      'List a directory in the repository. Directories end in "/". depth 1 (the default) lists one level; up to 4.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory relative to the repository root. Default ".".',
        },
        depth: { type: 'integer', description: 'Levels to descend, 1 to 4. Default 1.' },
      },
    },
  },
  async run(input, ctx) {
    const root = within(ctx.cwd, str(input, 'path'));
    const depth = int(input, 'depth', 1, 4) ?? 1;
    const stat = await fs.promises.stat(root);
    if (!stat.isDirectory())
      return { output: `${relative(ctx.cwd, root)} is not a directory.`, isError: true };
    const out: string[] = [];
    let cut = false;
    const walk = async (dir: string, level: number): Promise<void> => {
      const entries = (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      for (const e of entries) {
        if (e.name === '.git') continue;
        if (out.length >= MAX_LIST_ENTRIES) {
          cut = true;
          return;
        }
        const abs = path.join(dir, e.name);
        const rel = relative(ctx.cwd, abs);
        out.push(e.isDirectory() ? `${rel}/` : rel);
        if (e.isDirectory() && level < depth) await walk(abs, level + 1);
      }
    };
    await walk(root, 1);
    if (out.length === 0) return { output: '(empty directory)', isError: false };
    return {
      output: `${out.join('\n')}${cut ? `\n[Stopped at ${MAX_LIST_ENTRIES} entries. List a subdirectory to see more.]` : ''}`,
      isError: false,
    };
  },
};

const searchFiles: BuiltinTool = {
  name: 'fs.search',
  risk: 'read',
  definition: {
    name: 'search_files',
    description:
      'Search file contents in the repository with an extended regular expression (git grep -E). ' +
      'Searches tracked and untracked files, skipping ignored ones. Returns path:line:text.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Extended regular expression.' },
        path: { type: 'string', description: 'Limit the search to this file or directory.' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
  },
  async run(input, ctx) {
    const pattern = str(input, 'pattern', true);
    const scope = str(input, 'path');
    const rel = scope ? relative(ctx.cwd, within(ctx.cwd, scope)) : '.';
    const args = ['grep', '-n', '-I', '--untracked', '-E', '--full-name'];
    if (input.ignore_case === true) args.push('-i');
    args.push('-e', pattern, '--', rel);
    const r = await command(ctx, 'git', args, 60_000);
    if (r.code === 1 && !r.out) return { output: 'No matches.', isError: false };
    if (r.code !== 0) return { output: r.out || `git grep exited with ${r.code}.`, isError: true };
    return {
      output: truncateOutput(r.out, {
        maxChars: MAX_RESULT_CHARS,
        tailShare: 0,
        hint: 'Narrow the pattern or give a path to see the rest.',
      }).text,
      isError: false,
    };
  },
};

const writeFile: BuiltinTool = {
  name: 'fs.write',
  risk: 'write',
  definition: {
    name: 'write_file',
    description:
      'Create or replace a file in the repository with the given content. Parent directories are created. ' +
      'To change part of an existing file, use edit_file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the repository root.' },
        content: { type: 'string', description: 'The whole new content of the file.' },
      },
      required: ['path', 'content'],
    },
  },
  async run(input, ctx) {
    const rel = str(input, 'path', true);
    const content = str(input, 'content', true);
    const abs = within(ctx.cwd, rel);
    const existed = fs.existsSync(abs);
    if (existed && !(await fs.promises.stat(abs)).isFile()) {
      return { output: `${rel} exists and is not a file.`, isError: true };
    }
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    // Created after the check, so a link planted in between could still point
    // out; check the real path once more now that the directories exist.
    resolveWithinRoot(ctx.cwd, relative(ctx.cwd, abs));
    await writeContained(abs, content, !existed);
    return {
      output: `${existed ? 'Replaced' : 'Created'} ${relative(ctx.cwd, abs)} (${Buffer.byteLength(content)} bytes).`,
      isError: false,
    };
  },
};

const editFile: BuiltinTool = {
  name: 'fs.edit',
  risk: 'write',
  definition: {
    name: 'edit_file',
    description:
      'Replace text in an existing file. old_text must match exactly, including whitespace, and appear once ' +
      'unless replace_all is true. Read the file first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the repository root.' },
        old_text: { type: 'string', description: 'The exact text to replace.' },
        new_text: { type: 'string', description: 'The text to put in its place.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  async run(input, ctx) {
    const rel = str(input, 'path', true);
    const oldText = str(input, 'old_text', true);
    const newText = str(input, 'new_text', true);
    if (!oldText)
      return { output: 'old_text is empty; use write_file to create a file.', isError: true };
    const abs = within(ctx.cwd, rel);
    if (!fs.existsSync(abs)) return { output: `${rel} does not exist.`, isError: true };
    const text = await fs.promises.readFile(abs, 'utf8');
    const count = text.split(oldText).length - 1;
    if (count === 0) {
      return {
        output: `old_text was not found in ${rel}. Read the file and copy the text exactly.`,
        isError: true,
      };
    }
    if (count > 1 && input.replace_all !== true) {
      return {
        output: `old_text appears ${count} times in ${rel}. Include more surrounding text, or set replace_all.`,
        isError: true,
      };
    }
    await writeContained(abs, text.split(oldText).join(newText), false);
    return {
      output: `Edited ${rel}: ${count} replacement${count === 1 ? '' : 's'}.`,
      isError: false,
    };
  },
};

const runShell: BuiltinTool = {
  name: 'runtime.shell',
  risk: 'execute',
  definition: {
    name: 'run_shell',
    description:
      'Run a shell command (/bin/sh -c) in the repository root: tests, builds, package managers, git. ' +
      'Returns the exit code and output; long output keeps its start and end. Anything the command leaves ' +
      `running is stopped when it exits. timeout_seconds defaults to ${DEFAULT_SHELL_SECONDS}.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_seconds: { type: 'integer', description: `1 to ${MAX_SHELL_SECONDS}.` },
      },
      required: ['command'],
    },
  },
  async run(input, ctx) {
    const cmd = str(input, 'command', true);
    const seconds = int(input, 'timeout_seconds', 1, MAX_SHELL_SECONDS) ?? DEFAULT_SHELL_SECONDS;
    const [file, args] =
      process.platform === 'win32'
        ? ['cmd.exe', ['/d', '/s', '/c', cmd]]
        : ['/bin/sh', ['-c', cmd]];
    const r = await command(ctx, file, args, seconds * 1000);
    const status = r.cancelled
      ? 'cancelled'
      : r.timedOut
        ? `timed out after ${seconds}s`
        : `exit code ${r.code ?? 'none'}`;
    const body = truncateOutput(r.out, {
      maxChars: MAX_RESULT_CHARS,
      hint: 'Redirect the output to a file and read_file it with offset, or narrow the command.',
    }).text;
    return { output: `[${status}]${body ? `\n${body}` : ''}`, isError: r.code !== 0 };
  },
};

const gitStatus: BuiltinTool = {
  name: 'git.status',
  risk: 'read',
  definition: {
    name: 'git_status',
    description:
      'Show the branch and which files are changed, staged or untracked (git status --short --branch).',
    inputSchema: { type: 'object', properties: {} },
  },
  async run(_input, ctx) {
    const r = await command(ctx, 'git', ['status', '--short', '--branch'], 60_000);
    return { output: r.out || 'Clean.', isError: r.code !== 0 };
  },
};

const gitDiff: BuiltinTool = {
  name: 'git.diff',
  risk: 'read',
  definition: {
    name: 'git_diff',
    description:
      'Show changes not yet committed (git diff HEAD), optionally for one path. stat: true gives a summary only.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Limit the diff to this file or directory.' },
        stat: { type: 'boolean' },
      },
    },
  },
  async run(input, ctx) {
    const scope = str(input, 'path');
    const args = ['diff', 'HEAD', '--no-color', '--no-ext-diff'];
    if (input.stat === true) args.push('--stat');
    if (scope) args.push('--', relative(ctx.cwd, within(ctx.cwd, scope)));
    const r = await command(ctx, 'git', args, 60_000);
    if (r.code !== 0) return { output: r.out || `git diff exited with ${r.code}.`, isError: true };
    return {
      output: truncateOutput(r.out || 'No changes.', {
        maxChars: MAX_RESULT_CHARS,
        tailShare: 0,
        hint: 'Diff one path at a time, or use stat: true.',
      }).text,
      isError: false,
    };
  },
};

/** Every tool the builtin agent has, in the order the model is shown them. */
export const BUILTIN_TOOLS: readonly BuiltinTool[] = [
  readFile,
  listFiles,
  searchFiles,
  writeFile,
  editFile,
  runShell,
  gitStatus,
  gitDiff,
];

/** Characters of a sub-agent's task. */
const MAX_TASK_CHARS = 20_000;

/**
 * `sessions.spawn`: a sub-agent with a task of its own, in the same worktree,
 * under a policy cut from this agent's (read-only unless it asks for more, and
 * never more than this agent has). It answers with its final message. Not in
 * BUILTIN_TOOLS: it is offered only to a run that can start sub-agents.
 */
export const SPAWN_AGENT: BuiltinTool = {
  name: 'sessions.spawn',
  risk: 'write',
  definition: {
    name: 'spawn_agent',
    description:
      'Start a sub-agent on a self-contained part of the task (research a question across the code, review a file, ' +
      'try an approach) and get back its final answer. It sees the same repository but none of this conversation, ' +
      'so the task must say everything it needs. By default it can only read; name tools (e.g. ["fs.write", ' +
      '"fs.edit", "runtime.shell"]) to let it change files, which it can only do where you can. Several spawn_agent ' +
      'calls in one reply run at the same time (at most 4 at once); sub-agents that write in parallel can overwrite ' +
      "each other's changes, so give them separate files. A sub-agent cannot start sub-agents of its own. Its cost " +
      "counts against this run's budget.",
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'What the sub-agent is to do and what to report back, in full.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Tools it may use, as policy names or rules (fs.read, fs.write, fs.edit, runtime.shell, group:fs, ' +
            'risk:read). Default: the read-only tools.',
        },
        model: {
          type: 'string',
          description:
            'A model of its own, as provider/model. Default: the model this run is using.',
        },
      },
      required: ['task'],
    },
  },
  async run(input, ctx) {
    if (!ctx.spawn || !ctx.toolCallId) {
      return { output: 'This run cannot start sub-agents.', isError: true };
    }
    const task = str(input, 'task', true).trim();
    if (!task) throw new ToolInputError('"task" must say what the sub-agent is to do.');
    if (task.length > MAX_TASK_CHARS) {
      throw new ToolInputError(`"task" is over ${MAX_TASK_CHARS} characters; shorten it.`);
    }
    let tools: string[] | undefined;
    if (input.tools !== undefined && input.tools !== null) {
      if (
        !Array.isArray(input.tools) ||
        input.tools.some((t) => typeof t !== 'string' || !t.trim())
      ) {
        throw new ToolInputError('"tools" must be a list of tool names or rules.');
      }
      tools = (input.tools as string[]).map((t) => t.trim());
    }
    const model = str(input, 'model')?.trim() || undefined;
    return ctx.spawn(
      { task, ...(tools ? { tools } : {}), ...(model ? { model } : {}) },
      ctx.toolCallId
    );
  },
};

/**
 * What a shell command is, for policy. A command that publishes — `git push`,
 * or `gh` creating or merging a pull request or release — is judged as
 * `git.push`, which waits for approval as the runner's own push does. This is
 * a check of the words in the command, not a guarantee: a script can push
 * without saying so. It keeps an honest model from publishing unasked.
 */
export function shellDescriptor(command: string): ToolDescriptor {
  const publishes =
    /\bgit\b[^;&|\n]*\bpush\b/.test(command) ||
    /\bgh\s+(pr\s+(create|merge)|release\s+create|repo\s+create)\b/.test(command);
  return publishes
    ? { name: 'git.push', risk: 'external' }
    : { name: runShell.name, risk: runShell.risk };
}
