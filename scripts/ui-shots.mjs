#!/usr/bin/env node
/**
 * Screenshots of every page in both themes, over the fixture client.
 *
 *   pnpm ui:shots                     every page, light and dark, 1024×768, 1440×900 and 390×844
 *   pnpm ui:shots runs approvals      only pages whose name contains one of these words
 *
 * Uses the installed Chrome (set CHROME to another binary). Writes PNGs to
 * ui-shots/, which git ignores. Run before a release; CI does not.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'ui-shots');
const PORT = 1430;

const PAGES = [
  ['home', '/'],
  ['automations', '/m/automations'],
  ['automation', '/m/automations/aut_deps'],
  ['automation-spec', '/m/automations/aut_deps/spec'],
  ['automation-editor', '/m/automations/aut_deps/edit'],
  ['runs', '/runs'],
  ['run', '/runs/run_wait01'],
  ['run-live', '/runs/run_live01'],
  ['repos', '/repos'],
  ['repo', '/repos/repo_deps'],
  ['repo-folder-missing', '/repos/repo_licence'],
  ['repo-remote', '/repos/repo_gl_tools'],
  ['inbox', '/inbox'],
  ['inbox-reply', '/inbox/inb_1'],
  ['records', '/records'],
  ['record', '/records/per_ada'],
  ['record-panel', '/records/per_ada/notes.notes'],
  ['module', '/m/notes'],
  ['chat', '/m/chat/ses_1'],
  ['chat-compare', '/m/chat/ses_2'],
  ['chat-managed', '/m/chat/ses_3'],
  ['settings', '/settings/general'],
  ['settings-models', '/settings/models'],
  ['settings-triggers', '/settings/triggers'],
  ['settings-advanced', '/settings/advanced'],
  ['settings-devices', '/settings/devices'],
  ['settings-remote', '/settings/remote'],
  ['developer', '/developer/tools'],
  ['developer-log', '/developer/log'],
  ['gallery', '/dev/gallery'],
  ['empty-home', '/', 'empty'],
  ['empty-automations', '/m/automations', 'empty'],
  ['empty-repos', '/repos', 'empty'],
  ['offline-runs', '/runs', 'offline'],
];
const THEMES = ['light', 'dark'];
const SIZES = [
  [1024, 768],
  [1440, 900],
  [390, 844],
];

function chromeBinary() {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  return 'google-chrome';
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', ...opts });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))
    );
  });
}

/** A production build of the preview, served by Vite: one bundle loads fast, and no dev socket stays open. */
async function startPreview() {
  const web = path.join(ROOT, 'packages', 'web');
  await run('pnpm', ['exec', 'vite', 'build', '--logLevel', 'warn'], {
    cwd: web,
    stdio: 'inherit',
  });
  const child = spawn('pnpm', ['exec', 'vite', 'preview'], {
    cwd: web,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The preview server did not start within 90 s.')),
      90_000
    );
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes(`:${PORT}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`The preview server exited with ${code}.`)));
  });
  return child;
}

async function main() {
  const filters = process.argv.slice(2);
  const pages = PAGES.filter(([name]) => !filters.length || filters.some((f) => name.includes(f)));
  mkdirSync(OUT, { recursive: true });
  const preview = await startPreview();
  const chrome = chromeBinary();
  const profile = mkdtempSync(path.join(tmpdir(), 'clerq-shots-'));
  let count = 0;
  try {
    for (const [name, route, fixture] of pages) {
      for (const theme of THEMES) {
        for (const [w, h] of SIZES) {
          const query = new URLSearchParams({ theme, ...(fixture ? { fixture } : {}) });
          const app = `http://127.0.0.1:${PORT}/?${query}#${route}`;
          // Narrower than Chrome's smallest window: draw it in a phone-sized frame.
          const phone = w < 500;
          const url = phone
            ? `http://127.0.0.1:${PORT}/phone.html#${encodeURIComponent(app)}`
            : app;
          const file = path.join(OUT, `${name}-${theme}-${w}x${h}.png`);
          await run(chrome, [
            '--headless=new',
            '--disable-gpu',
            '--hide-scrollbars',
            '--no-first-run',
            `--user-data-dir=${profile}`,
            `--window-size=${phone ? 390 : w},${h}`,
            '--virtual-time-budget=6000',
            `--screenshot=${file}`,
            url,
          ]);
          count++;
          process.stdout.write(`${path.relative(ROOT, file)}\n`);
        }
      }
    }
  } finally {
    preview.kill();
    rmSync(profile, { recursive: true, force: true });
  }
  console.log(`${count} screenshots in ${path.relative(ROOT, OUT)}/`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
