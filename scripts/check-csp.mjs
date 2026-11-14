#!/usr/bin/env node
/**
 * Runs the desktop app's built frontend under the Content-Security-Policy in
 * apps/desktop/src-tauri/tauri.conf.json and fails on any violation.
 *
 *   pnpm csp:check                       the screens below, against a gateway started for the run
 *   pnpm csp:check --build               build the desktop frontend and the gateway first
 *   pnpm csp:check --policy "<policy>"   try another policy (to see what a change would break)
 *   pnpm csp:check --verbose             say what is happening
 *
 * What it does:
 *   1. starts a real gateway (packages/gateway/dist) on a free port with a temporary HOME, the
 *      bundled chat plugin as the desktop carries it, and the module example that has a UI;
 *   2. serves apps/desktop/dist (what the desktop bundles) over HTTP with the policy as the
 *      `Content-Security-Policy` header, as Tauri does for its own pages;
 *   3. opens it in headless Chrome, which is driven through the DevTools protocol, with the
 *      desktop's Tauri commands answered by a stand-in (the token, the config that points the
 *      app at the gateway's address: the "Gateway URL" setting, a port other than 18790);
 *   4. visits the main screens, among them chat, a module's own page in a frame, Settings and
 *      the developer log, and records every `securitypolicyviolation` event, every request
 *      Chrome blocked for the policy and every console message about it.
 *   5. as a control, makes a page do what the policy forbids (an inline script and style, a
 *      fetch and a frame to another site, an image from a data: address) and requires each to
 *      be seen, so "no violations" cannot mean the recorder is deaf.
 *
 * Exit status: 0 when no screen caused a violation, the screens drew, and the control was seen.
 *
 * What this shows and what it does not: the policy holds for these pages in Chrome's engine.
 * The app runs in the system's own webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on
 * Linux), which can differ, and the page is served over http here, not from Tauri's protocol:
 * Tauri also adds its own sources to the policy for its protocol and for any inline script or
 * style it finds in the HTML (there is none). The desktop app was not launched for this.
 *
 * Needs Chrome (CHROME=/path to use another binary; the default is the usual place on a Mac,
 * else `google-chrome`) and Node 22 or later (the global WebSocket). On CI it passes --no-sandbox.
 * Never uses ports 18790-18792; every port is picked by the system.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_CONF = path.join(ROOT, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
const DIST = path.join(ROOT, 'apps', 'desktop', 'dist');
const GATEWAY = path.join(ROOT, 'packages', 'gateway', 'dist', 'cli.js');
const CHAT_MANIFEST = path.join(ROOT, 'packages', 'plugin-chat', 'manifest.json');
const MODULE_EXAMPLE = path.join(ROOT, 'packages', 'module-sdk', 'examples', 'hello-world');

// ---------------------------------------------------------------------------
// The policy: tauri.conf.json's `app.security.csp`, a string or a map of directives
// ---------------------------------------------------------------------------

/** The directives of a policy as `{ name: [source, ...] }`, from Tauri's string or map form. */
export function parsePolicy(csp) {
  if (csp === null || csp === undefined) return null;
  if (typeof csp === 'string') {
    const out = {};
    for (const part of csp.split(';')) {
      const words = part.trim().split(/\s+/).filter(Boolean);
      if (words.length > 0) out[words[0].toLowerCase()] = words.slice(1);
    }
    return out;
  }
  const out = {};
  for (const [name, value] of Object.entries(csp)) {
    out[name.toLowerCase()] = (Array.isArray(value) ? value : String(value).split(/\s+/)).filter(Boolean);
  }
  return out;
}

/** The header value Tauri sends: `name source source; name source`. */
export function policyHeader(csp) {
  const policy = parsePolicy(csp);
  if (!policy) throw new Error('The config has no Content-Security-Policy (csp is null).');
  return Object.entries(policy)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ');
}

/** `app.security.csp` of a tauri.conf.json. */
export function policyOfConfig(file = TAURI_CONF) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))?.app?.security?.csp ?? null;
}

// ---------------------------------------------------------------------------
// What is visited
// ---------------------------------------------------------------------------

/**
 * [route, text the page must show, a note]. A page that did not draw proves nothing, so each
 * must show something that only the real screen has.
 */
export const SCREENS = [
  ['/', 'get started', 'home'],
  ['/m/automations', 'no automations yet', 'automations'],
  ['/runs', 'any status', 'runs'],
  ['/repos', 'on disk', 'repositories'],
  ['/inbox', 'nothing is waiting for you', 'inbox'],
  ['/records', 'no records yet', 'shared records'],
  ['/m/chat', 'new conversation', 'chat console (the bundled plugin\u2019s page)'],
  ['/m/hello-world', null, 'a module\u2019s own page, in a frame'],
  ['/settings/general', 'emergency stop', 'Settings: general'],
  ['/settings/models', 'default model', 'Settings: models'],
  ['/settings/memory', 'what chats and tasks may read', 'Settings: memory'],
  ['/settings/triggers', 'start a task on a schedule', 'Settings: triggers'],
  ['/settings/advanced', 'gateway url', 'Settings: advanced (the service address field)'],
  ['/settings/devices', 'pair a phone', 'Settings: devices'],
  ['/settings/remote', 'remote access', 'Settings: remote'],
  ['/settings/github', 'github app', 'Settings: GitHub'],
  ['/developer/tools', 'try a tool', 'developer: tools'],
  ['/developer/log', 'gateway started', 'developer: the live log (arrives over an event stream)'],
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A free port on 127.0.0.1, never one of 18790-18792. */
async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
    if (port < 18790 || port > 18792) return port;
  }
}

function chromeBinary() {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  return 'google-chrome';
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** The desktop's built frontend, every response carrying the policy as Tauri's protocol does. */
function serveApp(header, log) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-security-policy': header }).end();
      log(`404 ${url.pathname}`);
      return;
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-security-policy': header,
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

/** Start a gateway for the run. Returns { url, token, stop }. */
async function startGateway({ port, appOrigin, log }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-csp-gw-'));
  const home = path.join(work, 'home');
  const bundled = path.join(work, 'bundled-plugins');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(bundled, 'chat'), { recursive: true });
  fs.copyFileSync(CHAT_MANIFEST, path.join(bundled, 'chat', 'manifest.json'));
  // A clean environment: nothing of the user's (keys, tokens) reaches the gateway.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    CLERQ_PORT: String(port),
    CLERQ_HOST: '127.0.0.1',
    CLERQ_KEYCHAIN: 'off',
    CLERQ_CORS_ORIGINS: appOrigin,
    CLERQ_BUNDLED_PLUGINS_DIR: bundled,
    CLERQ_MODULES_DIR: MODULE_EXAMPLE,
  };
  const child = spawn(process.execPath, [GATEWAY], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  let exited = false;
  child.on('exit', () => (exited = true));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    if (exited) throw new Error(`The gateway exited at start:\n${output}`);
    try {
      const r = await fetch(`${url}/v1/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(100);
    if (i === 299) throw new Error(`The gateway did not answer in 30 s:\n${output}`);
  }
  const tokenFile = path.join(home, '.clerq', 'gateway-token');
  for (let i = 0; i < 100 && !fs.existsSync(tokenFile); i++) await sleep(100);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  log(`gateway on ${url} (HOME ${home})`);
  return {
    url,
    token,
    stop: () => {
      child.kill('SIGTERM');
      fs.rmSync(work, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// The DevTools protocol, as little of it as is needed
// ---------------------------------------------------------------------------

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('Could not connect to Chrome\u2019s DevTools port.')), {
      once: true,
    });
  });
  let next = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (const h of handlers.get(msg.method) ?? []) h(msg.params);
    }
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    on: (method, fn) => handlers.set(method, [...(handlers.get(method) ?? []), fn]),
    close: () => ws.close(),
  };
}

/** The page every document gets before its own scripts: the violation recorder, the Tauri stand-in. */
function injected({ token, config }) {
  return `(() => {
  if (window.top !== window) return;
  const report = (v) => { try { window.__reportCsp(JSON.stringify(v)); } catch (e) {} };
  document.addEventListener('securitypolicyviolation', (e) => report({
    directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile || '', line: e.lineNumber,
    sample: e.sample || '', disposition: e.disposition,
  }));
  const token = ${JSON.stringify(token)};
  const config = ${JSON.stringify(config)};
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window['_' + id] = cb; return id; },
    convertFileSrc: (p) => p,
    invoke: async (cmd) => {
      if (cmd === 'gateway_token') return token;
      if (cmd === 'read_config') return config;
      if (cmd === 'plugin:notification|is_permission_granted') return false;
      return null;
    },
  };
})();`;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { build: false, verbose: false, policy: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--build') o.build = true;
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--policy') {
      o.policy = argv[++i];
      if (!o.policy) throw new Error('--policy needs a policy.');
    } else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`Unknown argument ${a}.`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, ''));
    return 0;
  }
  const log = (...m) => o.verbose && console.error('[csp]', ...m);
  if (o.build) {
    const r = spawnSync('pnpm', ['--filter', '@clerq/desktop...', 'build'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('The build failed.');
  }
  for (const f of [path.join(DIST, 'index.html'), GATEWAY]) {
    if (!fs.existsSync(f)) {
      throw new Error(`${path.relative(ROOT, f)} is missing: run \`pnpm build\` first (or pass --build).`);
    }
  }
  const header = o.policy ?? policyHeader(policyOfConfig());
  console.log(`Policy: ${header}\n`);

  const children = [];
  const cleanup = [];
  let failed = 0;
  try {
    // The app's origin comes first: the gateway has to allow it.
    const appServer = await serveApp(header, log);
    cleanup.push(() => appServer.close());
    const appPort = appServer.address().port;
    const appOrigin = `http://127.0.0.1:${appPort}`;
    const gw = await startGateway({ port: await freePort(), appOrigin, log });
    cleanup.push(gw.stop);

    const dbgPort = await freePort();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'clerq-csp-chrome-'));
    const chromeArgs = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${dbgPort}`,
      '--window-size=1280,900',
      ...(process.env.CI ? ['--no-sandbox'] : []),
      'about:blank',
    ];
    const chrome = spawn(chromeBinary(), chromeArgs, { stdio: 'ignore' });
    children.push(chrome);
    cleanup.push(() => {
      chrome.kill('SIGTERM');
      fs.rmSync(profile, { recursive: true, force: true });
    });
    let chromeError;
    chrome.on('error', (e) => (chromeError = e));
    let target;
    for (let i = 0; i < 200 && !target; i++) {
      if (chromeError) {
        throw new Error(`Could not start Chrome (${chromeBinary()}): ${chromeError.message}. Set CHROME to its path.`);
      }
      try {
        const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
        target = list.find((t) => t.type === 'page');
      } catch {
        /* not up yet */
      }
      if (!target) await sleep(100);
    }
    if (!target) throw new Error('Chrome did not open a page in 20 s.');
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    cleanup.push(() => cdp.close());

    /** Everything seen, with the screen it was seen on. */
    let current = 'start';
    const violations = [];
    const note = (kind, detail) => violations.push({ screen: current, kind, ...detail });
    cdp.on('Runtime.bindingCalled', (p) => {
      if (p.name === '__reportCsp') note('event', JSON.parse(p.payload));
    });
    cdp.on('Network.loadingFailed', (p) => {
      if (p.blockedReason === 'csp') note('blocked request', { directive: 'request', blocked: p.requestId });
    });
    cdp.on('Log.entryAdded', ({ entry }) => {
      if (/Content Security Policy|Refused to/.test(entry.text)) note('log', { text: entry.text.slice(0, 300) });
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (/Content Security Policy|Refused to/.test(text)) note('console', { text: text.slice(0, 300) });
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const text = p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '';
      if (/Content Security Policy|Refused to/.test(text)) note('exception', { text: text.slice(0, 300) });
    });
    const frames = [];
    cdp.on('Network.responseReceived', (p) => frames.push({ url: p.response.url, status: p.response.status }));
    /** Requests the page made to the gateway, so that "no violation" is known to cover real calls. */
    const calls = [];
    cdp.on('Network.requestWillBeSent', (p) => {
      if (p.request.url.startsWith(gw.url)) calls.push(`${p.request.method} ${p.request.url.slice(gw.url.length)}`);
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.addBinding', { name: '__reportCsp' });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: injected({
        token: gw.token,
        config: JSON.stringify({ settings: { gatewayUrl: gw.url } }),
      }),
    });
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    const waitFor = async (expression, what, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await evaluate(expression).catch(() => false)) return;
        await sleep(100);
      }
      throw new Error(`Timed out waiting for ${what}.`);
    };

    current = 'load';
    await cdp.send('Page.navigate', { url: `${appOrigin}/?csp-check#/` });
    await waitFor(`document.getElementById('root')?.children.length > 0`, 'the app to draw');
    await sleep(1500);

    console.log(`Gateway ${gw.url}, app ${appOrigin} (the app is set to use that gateway through its own setting)\n`);
    const results = [];
    for (const [route, expectText, note_] of SCREENS) {
      current = route;
      const before = violations.length;
      await evaluate(`location.hash = ${JSON.stringify(`#${route}`)}; true`);
      let drew = true;
      let why = '';
      try {
        if (expectText) {
          await waitFor(
            `(document.getElementById('page-content')?.innerText ?? '').toLowerCase().includes(${JSON.stringify(expectText)})`,
            `"${expectText}" on ${route}`
          );
        } else {
          // A module's page: its frame must load from the gateway, as a 200.
          await waitFor(`document.querySelector('iframe.module-frame-iframe')?.src.includes('/ui/')`, 'the module frame');
          const src = await evaluate(`document.querySelector('iframe.module-frame-iframe').src`);
          const start = Date.now();
          while (!frames.some((f) => f.url === src && f.status === 200)) {
            if (Date.now() - start > 15000) throw new Error(`the frame ${src} was not loaded`);
            await sleep(100);
          }
        }
      } catch (e) {
        drew = false;
        why = e.message;
      }
      if (route === '/m/chat' && drew) {
        // A conversation, so the page has made its calls and shown its composer.
        const button = (name) =>
          `[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.textContent).trim() === ${JSON.stringify(name)})`;
        await evaluate(`${button('New conversation')}?.click(); true`);
        try {
          await waitFor(`Boolean(document.querySelector('textarea'))`, 'the composer');
          // A message: there is no model key, so the gateway answers with an error, which is
          // still a call made and an answer drawn under the policy.
          await evaluate(`document.querySelector('textarea').focus(); true`);
          await cdp.send('Input.insertText', { text: 'Is the policy holding?' });
          await sleep(300);
          await evaluate(`${button('Send')}?.click(); true`);
          const start = Date.now();
          while (!calls.some((c) => /^POST \/v1\/sessions\/[^/]+\/send/.test(c))) {
            if (Date.now() - start > 10000) throw new Error('the message was never sent to the gateway');
            await sleep(100);
          }
        } catch (e) {
          drew = false;
          why = e.message;
        }
        await sleep(1500);
      }
      await sleep(1200); // the page's own requests and its event stream settle
      const mine = violations.slice(before);
      const ok = drew && mine.length === 0;
      if (!ok) failed++;
      results.push({ route, ok });
      const heading = o.verbose ? await evaluate(`(document.getElementById('page-content')?.innerText ?? '(no page)').replace(/\\s+/g, ' ').slice(0, 90)`) : '';
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${route.padEnd(22)} ${note_}${heading ? `  [page: ${heading}]` : ''}`);
      if (!drew) console.log(`       did not draw: ${why}`);
      for (const v of mine) console.log(`       ${JSON.stringify(v)}`);
    }

    // The control: the recorder must see what the policy forbids.
    current = 'control';
    const before = violations.length;
    await evaluate(`(() => {
      const s = document.createElement('script'); s.textContent = 'window.__ran = 1'; document.body.appendChild(s);
      const st = document.createElement('style'); st.textContent = 'body { outline: 0 }'; document.head.appendChild(st);
      fetch('https://csp-control.invalid/x').catch(() => {});
      const f = document.createElement('iframe'); f.src = 'https://csp-control.invalid/'; document.body.appendChild(f);
      const i = new Image(); i.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
      return true;
    })()`);
    await sleep(1500);
    const seen = new Set(violations.slice(before).map((v) => v.directive).filter(Boolean));
    const wanted = ['script-src-elem', 'style-src-elem', 'connect-src', 'frame-src', 'img-src'];
    const missing = wanted.filter((d) => !seen.has(d));
    const ran = await evaluate('window.__ran === 1');
    console.log(
      `\ncontrol: ${missing.length === 0 && !ran ? 'ok  ' : 'FAIL'} an inline script, an inline style, a fetch and a frame to another site and an image from a data: address were all blocked and seen` +
        (missing.length ? ` (not seen: ${missing.join(', ')})` : '') +
        (ran ? ' (the inline script RAN)' : '')
    );
    if (missing.length > 0 || ran) failed++;

    const kinds = new Map();
    for (const c of calls) {
      const key = c.replace(/\/[A-Za-z0-9_-]{8,}(?=\/|\?|$)/g, '/:id').split('?')[0];
      kinds.set(key, (kinds.get(key) ?? 0) + 1);
    }
    log(`calls to the gateway:\n  ${[...kinds].map(([k, n]) => `${n} x ${k}`).join('\n  ')}`);
    console.log(`\nThe app made ${calls.length} requests to the gateway (${kinds.size} kinds) while it was visited.`);
    console.log(
      failed === 0
        ? `${SCREENS.length} screens drew under the policy with no violation.`
        : `\n${failed} problem${failed === 1 ? '' : 's'}.`
    );
  } finally {
    for (const c of cleanup.reverse()) {
      try {
        c();
      } catch {
        /* closing */
      }
    }
    for (const c of children) c.kill('SIGTERM');
  }
  return failed === 0 ? 0 : 1;
}

/** Was this file started as the program, and not imported? (Real paths, so case and links do not matter.) */
function isMain() {
  try {
    return (
      fs.realpathSync.native(process.argv[1]) === fs.realpathSync.native(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(2);
    }
  );
}
