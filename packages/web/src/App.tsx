/**
 * The whole interface, ready to mount: <OpenClerqApp client host modules />.
 *
 * The desktop passes the gateway client and a Tauri host; another app passes
 * its own. Core pages (Home, Inbox, Runs, Repos, Records, Developer, Settings) are
 * always there. Modules add theirs under `#/m/<id>/…` through the slot
 * contract: bundled ones passed in, and every module the gateway runs.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Code,
  Contact,
  FolderGit2,
  History,
  House,
  Inbox as InboxIcon,
  Monitor,
  Moon,
  Settings as SettingsIcon,
  Sun,
} from 'lucide-react';
import { ToastProvider, useToast } from './ui/Toast';
import {
  EnvironmentContext,
  useClient,
  useHost,
  type AppConfig,
  type GatewayClient,
  type Host,
} from './app/client';
import { hitRoute, moduleRoute, useExtensions, useGatewayModules } from './app/extensions';
import { visit } from './app/history';
import { LiveProvider, useLive, type LiveStore } from './app/live';
import {
  moduleBase,
  renderBundled,
  storedPins,
  storePins,
  type ModuleRenderer,
  type ModuleUI,
  type PaletteCommand,
  type RailEntry,
} from './app/modules';
import { navigate, useRoute } from './app/router';
import { setTheme } from './app/theme';
import { Shell } from './shell/Shell';
import { Palette } from './shell/Palette';
import { AboutDialog } from './screens/About';
import { Home } from './screens/home/Home';
import { Runs } from './screens/runs/Runs';
import { Repos } from './screens/repos/Repos';
import { Inbox, useInbox } from './screens/inbox/Inbox';
import { Records } from './screens/records/Records';
import { gatewayModule } from './screens/InstalledModule';
import { Settings, SETTINGS_SECTIONS } from './screens/settings/Settings';
import { Developer } from './screens/developer/Developer';
import { NotFound } from './screens/NotFound';
import { Foundations } from './foundations/Foundations';

const CORE: RailEntry[] = [
  { id: 'home', label: 'Home', icon: House, path: '/', order: 0 },
  { id: 'runs', label: 'Runs', icon: History, path: '/runs', order: 20 },
  { id: 'inbox', label: 'Inbox', icon: InboxIcon, path: '/inbox', order: 5 },
  { id: 'repos', label: 'Repos', icon: FolderGit2, path: '/repos', order: 30, secondary: true },
  { id: 'records', label: 'Records', icon: Contact, path: '/records', order: 35, secondary: true },
  {
    id: 'developer',
    label: 'Developer',
    icon: Code,
    path: '/developer',
    order: 90,
    group: 'end',
    secondary: true,
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: SettingsIcon,
    path: '/settings',
    order: 100,
    group: 'end',
    secondary: true,
  },
];

/** Paths from before modules moved under /m/, kept so old links still open. */
const MOVED: Record<string, string> = { automations: 'automations', chat: 'chat' };

/** Bundled modules, then every module the gateway runs that is not one of them. */
function useAllModules(bundled: ModuleUI[]): ModuleUI[] {
  const gateway = useGatewayModules();
  const extensions = useExtensions();
  return useMemo(() => {
    const nav = extensions.data?.nav ?? [];
    const running = gateway.data ?? [];
    // A folder placeholder gives way to the gateway's own entry for the same module.
    const own = bundled.filter((b) => !(b.placeholder && running.some((m) => m.id === b.id)));
    const extra = running
      .filter((m) => !own.some((b) => b.id === m.id))
      .map((m) =>
        gatewayModule(
          m,
          nav.filter((n) => n.moduleId === m.id)
        )
      );
    return [...own, ...extra];
  }, [bundled, gateway.data, extensions.data]);
}

/**
 * Module notifications become native ones where the host can show them (a
 * toast otherwise), and the host's badge shows how much is waiting.
 */
function useNotifications(waiting: number) {
  const host = useHost();
  const live = useLive();
  const toast = useToast();
  useEffect(
    () =>
      live.onEvent((e) => {
        if (e.name !== 'notify.posted') return;
        const n = e.payload as {
          moduleId: string;
          title: string;
          body?: string;
          level?: string;
          link?: string;
        };
        const open = n.link ? () => navigate(moduleRoute(n.moduleId, n.link)) : undefined;
        if (host.notify) host.notify({ title: n.title, body: n.body, onClick: open });
        else
          toast({
            message: n.body ? `${n.title}: ${n.body}` : n.title,
            tone: n.level === 'error' ? 'err' : n.level === 'success' ? 'ok' : 'neutral',
            action: open ? { label: 'Open', onClick: open } : undefined,
          });
      }),
    [live, host, toast]
  );
  useEffect(() => host.setBadge?.(waiting), [host, waiting]);
}

export interface OpenClerqAppProps {
  client: GatewayClient;
  host: Host;
  /** Bundled and installed modules. Leave one out and its pages are gone. */
  modules?: ModuleUI[];
  /** Draws a module's pages; the default renders its component. */
  renderModule?: ModuleRenderer;
  /** A prepared cache, for fixtures and tests. */
  store?: LiveStore;
}

export function OpenClerqApp({
  client,
  host,
  modules = [],
  renderModule = renderBundled,
  store,
}: OpenClerqAppProps) {
  const env = useMemo(() => ({ client, host }), [client, host]);
  return (
    <EnvironmentContext.Provider value={env}>
      <LiveProvider client={client} store={store}>
        <ToastProvider>
          <AppFrame modules={modules} renderModule={renderModule} />
        </ToastProvider>
      </LiveProvider>
    </EnvironmentContext.Provider>
  );
}

function useConfig(host: Host): [AppConfig | null, (c: AppConfig) => Promise<void>] {
  const [config, setConfig] = useState<AppConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    (host.readConfig?.() ?? Promise.resolve({}))
      .then((c) => !cancelled && setConfig(c))
      .catch(() => !cancelled && setConfig({}));
    return () => {
      cancelled = true;
    };
  }, [host]);
  const save = useCallback(
    async (next: AppConfig) => {
      await host.writeConfig?.(next);
      setConfig(next);
    },
    [host]
  );
  return [config, save];
}

/** ⌘ on a Mac, Ctrl elsewhere. */
function isMod(e: KeyboardEvent): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
}

function inField(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return Boolean(t?.closest('input, textarea, select, [contenteditable="true"]'));
}

function AppFrame({
  modules: bundled,
  renderModule,
}: {
  modules: ModuleUI[];
  renderModule: ModuleRenderer;
}) {
  const client = useClient();
  const host = useHost();
  const route = useRoute();
  const { path, segments } = route;
  const location = `${path}${route.query.toString() ? `?${route.query.toString()}` : ''}`;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const modules = useAllModules(bundled);
  // Until the user pins or unpins, every module is pinned, including ones added later.
  const [pinned, setPinned] = useState<string[] | null>(storedPins);
  const pins = useMemo(() => pinned ?? modules.map((m) => m.id), [pinned, modules]);
  const inbox = useInbox();
  const gatewayModules = useGatewayModules();
  const [config, saveConfig] = useConfig(host);
  const waiting = inbox.data?.length ?? 0;
  useNotifications(waiting);

  const entries = useMemo(
    () => [...CORE, ...modules.flatMap((m) => m.rail.map((e) => ({ ...e, module: m.id })))],
    [modules]
  );

  useEffect(() => visit(location), [location]);

  // The page the app opens on, once, when it starts on Home with nothing in the address.
  useEffect(() => {
    const start = config?.settings?.defaultModule;
    if (start && start !== '/' && window.location.hash === '' && start.startsWith('/')) {
      navigate(start, { replace: true });
    }
  }, [config]);

  // Old paths open their new place.
  useEffect(() => {
    if (segments[0] === 'approvals') {
      navigate(segments[1] ? `/inbox/apr_${segments[1]}` : '/inbox', { replace: true });
      return;
    }
    const moved = MOVED[segments[0]];
    if (moved && modules.some((m) => m.id === moved)) {
      const rest = segments.slice(1).map(encodeURIComponent).join('/');
      const q = route.query.toString();
      navigate(`${moduleBase(moved)}${rest ? `/${rest}` : ''}${q ? `?${q}` : ''}`, {
        replace: true,
      });
    }
  }, [segments, route.query, modules]);

  const onPin = useCallback(
    (id: string, pinned: boolean) => {
      const next = pinned ? [...new Set([...pins, id])] : pins.filter((p) => p !== id);
      storePins(next);
      setPinned(next);
    },
    [pins]
  );

  // Keyboard: ⌘K palette, ⌘1–⌘9 rail pages, ⌘, settings.
  const railOrder = useMemo(
    () =>
      [...entries]
        .filter((e) => e.group !== 'end' && (!e.module || pins.includes(e.module)))
        .sort((a, b) => (a.order ?? 50) - (b.order ?? 50)),
    [entries, pins]
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMod(e) || e.altKey) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (e.key === ',') {
        e.preventDefault();
        navigate('/settings');
      } else if (/^[1-9]$/.test(e.key) && !inField(e)) {
        const target = railOrder[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          navigate(target.path);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [railOrder]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const go: PaletteCommand[] = [...entries]
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
      .map((e) => ({
        id: `go:${e.id}`,
        label: e.label,
        hint: 'Go to',
        icon: e.icon,
        keywords: 'page open',
        run: () => navigate(e.path),
      }));
    const settings: PaletteCommand[] = SETTINGS_SECTIONS.map((s) => ({
      id: `settings:${s.id}`,
      label: `Settings: ${s.label}`,
      icon: SettingsIcon,
      keywords: s.keywords,
      run: () => navigate(`/settings/${s.id}`),
    }));
    const theme: PaletteCommand[] = [
      {
        id: 'theme:light',
        label: 'Light theme',
        icon: Sun,
        keywords: 'appearance switch',
        run: () => setTheme('light'),
      },
      {
        id: 'theme:dark',
        label: 'Dark theme',
        icon: Moon,
        keywords: 'appearance switch',
        run: () => setTheme('dark'),
      },
      {
        id: 'theme:auto',
        label: 'Match system theme',
        icon: Monitor,
        keywords: 'appearance switch auto',
        run: () => setTheme('auto'),
      },
    ];
    const fromModules = modules.flatMap(
      (m) => m.commands?.({ client, navigate, base: moduleBase(m.id) }) ?? []
    );
    return [...go, ...fromModules, ...settings, ...theme];
  }, [entries, modules, client]);

  const search = useCallback(
    async (query: string): Promise<PaletteCommand[]> => {
      const tasks: Array<Promise<PaletteCommand[]>> = modules.map((m) =>
        m.search
          ? m.search(query, { client, navigate, base: moduleBase(m.id) }).catch(() => [])
          : Promise.resolve([])
      );
      // Records and every module's search extension, through the gateway.
      tasks.push(
        client
          .search(query, { limit: 20 })
          .then(({ results }) =>
            results.map((r) => ({
              id: `ref:${r.ref}`,
              label: r.title,
              hint: [r.subtitle, r.type ?? r.moduleId].filter(Boolean).join(' · '),
              run: () => navigate(hitRoute(r)),
            }))
          )
          .catch(() => [])
      );
      const lists = await Promise.all(tasks);
      const seen = new Set<string>();
      return lists.flat().filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    },
    [modules, client]
  );

  let page: ReactNode;
  const [first, second] = segments;
  if (!first) page = <Home />;
  else if (first === 'runs') page = <Runs id={second ?? null} />;
  else if (first === 'repos') page = <Repos id={second ?? null} />;
  else if (first === 'inbox') page = <Inbox id={second ?? null} />;
  else if (first === 'records') page = <Records id={second ?? null} tab={segments[2] ?? null} />;
  else if (first === 'approvals') page = null;
  else if (first === 'settings')
    page = (
      <Settings
        section={second ?? null}
        config={config}
        saveConfig={saveConfig}
        modules={modules}
      />
    );
  else if (first === 'developer') page = <Developer tool={second ?? null} />;
  else if (first === 'dev' && second === 'gallery') page = <Foundations embedded />;
  else if (first === 'm' && second) {
    const mod = modules.find((m) => m.id === second);
    page = mod ? (
      renderModule(mod, {
        route,
        parts: segments.slice(2),
        base: moduleBase(mod.id),
        client,
        host,
        config,
        navigate,
      })
    ) : (
      <NotFound what="module" />
    );
  } else if (MOVED[first]) page = null;
  else page = <NotFound />;

  return (
    <>
      <Shell
        entries={entries}
        modules={modules}
        pins={pins}
        onPin={onPin}
        location={location}
        badges={{
          inbox: waiting,
          ...Object.fromEntries(
            (gatewayModules.data ?? []).filter((m) => m.badge).map((m) => [m.id, m.badge as string])
          ),
        }}
        path={path}
        onOpenPalette={() => setPaletteOpen(true)}
        onAbout={() => setAboutOpen(true)}
      >
        {page}
      </Shell>
      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        search={search}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  );
}
