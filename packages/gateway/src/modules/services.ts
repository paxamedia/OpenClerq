/**
 * Service supervision: start, stop and status of the launchd agents a module
 * declares in its manifest, and only those.
 *
 *   "services": [{ "label": "org.example.worker", "plist": "~/Library/LaunchAgents/org.example.worker.plist" }]
 *
 * `plist` defaults to ~/Library/LaunchAgents/<label>.plist. Start loads the
 * agent if launchd does not have it (bootstrap) and starts it (kickstart);
 * stop unloads it (bootout), so KeepAlive cannot bring it straight back.
 *
 * macOS only for now; systemd comes later. CLERQ_LAUNCHCTL points at another
 * launchctl, which is how the tests use a fake one.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit } from '@clerq/store';
import { getStore } from '../store.js';
import { emit } from '../events.js';
import { logger } from '../logger.js';

export interface ServiceDecl {
  label: string;
  plist: string;
  name?: string;
}

export interface ServiceStatus {
  label: string;
  name?: string;
  /** launchd has the agent. */
  loaded: boolean;
  running: boolean;
  pid: number | null;
  lastExitCode: number | null;
}

export class ServiceError extends Error {
  constructor(
    readonly code: 'not_declared' | 'unsupported' | 'failed',
    message: string
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

/** The manifest's `services`, well-formed ones only. */
export function servicesOf(manifest: Record<string, unknown>): ServiceDecl[] {
  const raw = manifest.services;
  if (!Array.isArray(raw)) return [];
  const out: ServiceDecl[] = [];
  for (const s of raw) {
    const entry = typeof s === 'string' ? { label: s } : (s as Record<string, unknown>);
    const label = typeof entry?.label === 'string' ? entry.label : '';
    if (!LABEL.test(label)) continue;
    out.push({
      label,
      name: typeof entry.name === 'string' ? entry.name : undefined,
      plist: expandHome(
        typeof entry.plist === 'string'
          ? entry.plist
          : path.join('~', 'Library', 'LaunchAgents', `${label}.plist`)
      ),
    });
  }
  return out;
}

function launchctl(): string {
  return process.env.CLERQ_LAUNCHCTL || '/bin/launchctl';
}

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(launchctl(), args, { timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

export class ModuleServices {
  constructor(
    private readonly moduleId: string,
    private readonly declared: ServiceDecl[]
  ) {}

  list(): ServiceDecl[] {
    return this.declared;
  }

  private find(label: string): ServiceDecl {
    const decl = this.declared.find((s) => s.label === label);
    if (!decl) {
      throw new ServiceError('not_declared', `${label} is not a service this module declares.`);
    }
    if (process.platform !== 'darwin' && !process.env.CLERQ_LAUNCHCTL) {
      throw new ServiceError('unsupported', 'Service control needs launchd (macOS) for now.');
    }
    return decl;
  }

  async status(label: string): Promise<ServiceStatus> {
    const decl = this.find(label);
    const out = await run(['print', `${domain()}/${label}`]);
    if (out.code !== 0) {
      return {
        label,
        name: decl.name,
        loaded: false,
        running: false,
        pid: null,
        lastExitCode: null,
      };
    }
    const pid = /^\s*pid = (\d+)/m.exec(out.stdout);
    const state = /^\s*state = (\w+)/m.exec(out.stdout);
    const exit = /^\s*last exit code = (-?\d+)/m.exec(out.stdout);
    return {
      label,
      name: decl.name,
      loaded: true,
      running: state?.[1] === 'running',
      pid: pid ? Number(pid[1]) : null,
      lastExitCode: exit ? Number(exit[1]) : null,
    };
  }

  async start(label: string, actor = 'operator'): Promise<ServiceStatus> {
    const decl = this.find(label);
    if (!(await this.status(label)).loaded) {
      if (!fs.existsSync(decl.plist)) {
        throw new ServiceError(
          'failed',
          `${label} is not loaded and ${decl.plist} does not exist.`
        );
      }
      const boot = await run(['bootstrap', domain(), decl.plist]);
      if (boot.code !== 0) {
        throw new ServiceError(
          'failed',
          `launchctl bootstrap failed: ${boot.stderr.trim() || boot.code}`
        );
      }
    }
    const kick = await run(['kickstart', `${domain()}/${label}`]);
    if (kick.code !== 0) {
      throw new ServiceError(
        'failed',
        `launchctl kickstart failed: ${kick.stderr.trim() || kick.code}`
      );
    }
    this.record('start', label, actor);
    return this.status(label);
  }

  async stop(label: string, actor = 'operator'): Promise<ServiceStatus> {
    this.find(label);
    if ((await this.status(label)).loaded) {
      const out = await run(['bootout', `${domain()}/${label}`]);
      if (out.code !== 0) {
        throw new ServiceError(
          'failed',
          `launchctl bootout failed: ${out.stderr.trim() || out.code}`
        );
      }
    }
    this.record('stop', label, actor);
    return this.status(label);
  }

  private record(action: 'start' | 'stop', label: string, actor: string): void {
    logger.info(`Module service ${action}`, { moduleId: this.moduleId, label });
    try {
      audit(getStore(), {
        actor,
        action: `module.${this.moduleId}.service.${action}`,
        subject: label,
      });
    } catch {
      /* the action happened; a failed audit write must not report it as failed */
    }
    emit('service.changed', { moduleId: this.moduleId, label, action });
  }
}
