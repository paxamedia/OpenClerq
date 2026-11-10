/**
 * A module's own UI in a frame, served by the gateway at
 * `/api/modules/<id>/ui/<path>`. The frame gets a short-lived module token by
 * postMessage, `{ type: 'clerq:token', token, expiresAt }`, renewed before it
 * expires. It may post back:
 *
 *   { type: 'clerq:token-request' }        send the token again
 *   { type: 'clerq:navigate', path }       open `#/m/<id>/<path>` in the shell
 *   { type: 'clerq:height', height }       size the frame to its content (tiles, panels)
 *
 * It also receives `{ type: 'clerq:theme', theme: 'light' | 'dark' }`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ProgressLine } from '../ui/Display';
import { cx } from '../ui/cx';
import { useClient } from '../app/client';
import { moduleRoute } from '../app/extensions';
import { errorMessage } from '../app/format';
import { navigate } from '../app/router';
import { useTheme } from '../app/theme';
import { ErrorState } from './layout';
import './module-frame.css';

/** Renew this long before the token expires. */
const RENEW_EARLY_MS = 60_000;

function resolvedTheme(theme: string): 'light' | 'dark' {
  const forced =
    typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined;
  if (forced === 'light' || forced === 'dark') return forced;
  if (theme === 'light' || theme === 'dark') return theme;
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** True when a path (before any query or fragment) has a `.` or `..` segment, however encoded. */
export function hasDotSegment(path: string): boolean {
  const pathOnly = path.split(/[?#]/)[0];
  return pathOnly.split(/[/\\]/).some((seg) => {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return true;
    }
    return decoded.split(/[/\\]/).some((d) => d === '.' || d === '..');
  });
}

/**
 * Where a module's UI is served, or null when the path would leave it: a `.` or
 * `..` segment would load another module's UI from this module's frame.
 */
export function moduleUiUrl(base: string, moduleId: string, path: string): string | null {
  const inner = path.replace(/^\/+/, '');
  if (hasDotSegment(inner)) return null;
  const prefix = `/api/modules/${encodeURIComponent(moduleId)}/ui/`;
  const url = `${base.replace(/\/$/, '')}${prefix}${inner}`;
  try {
    return new URL(url).pathname.startsWith(prefix) ? url : null;
  } catch {
    return null;
  }
}

interface Minted {
  token: string;
  expiresAt: string;
}
const minted = new Map<string, Promise<Minted>>();

/**
 * A module token for a frame. A token that is not near expiry is reused, so a
 * page of frames, or one frame reloading, does not mint one per load.
 */
export async function reusableToken(
  key: string,
  mint: () => Promise<Minted>,
  now = Date.now()
): Promise<Minted> {
  const held = minted.get(key);
  if (held) {
    try {
      const t = await held;
      if (Date.parse(t.expiresAt) - now > RENEW_EARLY_MS) return t;
    } catch {
      /* mint a new one below */
    }
    if (minted.get(key) !== held) return reusableToken(key, mint, now);
  }
  const fresh = mint();
  minted.set(key, fresh);
  fresh.catch(() => {
    if (minted.get(key) === fresh) minted.delete(key);
  });
  return fresh;
}

/** For tests. */
export function forgetTokens(): void {
  minted.clear();
}

export interface ModuleFrameProps {
  moduleId: string;
  /** A path inside the module's UI, e.g. "/" or "/?ref=core:person:per_1". */
  path: string;
  /** Names the frame for screen readers. */
  title: string;
  /** fill: the rest of the page; fit: as tall as the module asks, for tiles and panels. */
  layout?: 'fill' | 'fit';
  className?: string;
}

export function ModuleFrame({
  moduleId,
  path,
  title,
  layout = 'fill',
  className,
}: ModuleFrameProps) {
  const client = useClient();
  const [theme] = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const token = useRef<{ token: string; expiresAt: string } | null>(null);
  const renew = useRef<ReturnType<typeof setTimeout>>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  const base = client.getUrl();
  const origin = new URL(base).origin;
  const src = moduleUiUrl(base, moduleId, path);
  const alive = useRef(true);
  const generation = useRef(0);

  const post = useCallback(
    (message: Record<string, unknown>) =>
      frame.current?.contentWindow?.postMessage(message, origin),
    [origin]
  );

  // One renewal timer per frame. A call that finishes after a newer one started,
  // or after the frame is gone, does nothing.
  const sendToken = useCallback(async () => {
    const mine = ++generation.current;
    clearTimeout(renew.current);
    try {
      const t = await reusableToken(`${base}|${moduleId}`, () => client.moduleToken(moduleId));
      if (!alive.current || mine !== generation.current) return;
      token.current = t;
      post({ type: 'clerq:token', token: t.token, expiresAt: t.expiresAt });
      const wait = Date.parse(t.expiresAt) - Date.now() - RENEW_EARLY_MS;
      renew.current = setTimeout(() => void sendToken(), Math.max(10_000, wait));
      setError(null);
    } catch (e) {
      if (alive.current && mine === generation.current) setError(e);
    }
  }, [client, base, moduleId, post]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      clearTimeout(renew.current);
    };
  }, []);

  useEffect(() => {
    if (loaded) post({ type: 'clerq:theme', theme: resolvedTheme(theme) });
  }, [loaded, theme, post]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== origin) return;
      const data = e.data as { type?: string; path?: unknown; height?: unknown } | null;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'clerq:token-request') void sendToken();
      else if (data.type === 'clerq:navigate' && typeof data.path === 'string')
        navigate(moduleRoute(moduleId, data.path));
      else if (
        data.type === 'clerq:height' &&
        typeof data.height === 'number' &&
        layout === 'fit'
      ) {
        frame.current?.style.setProperty(
          '--frame-height',
          `${Math.min(1200, Math.max(40, Math.round(data.height)))}px`
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, moduleId, layout, sendToken]);

  return (
    <div className={cx('module-frame', `module-frame--${layout}`, className)}>
      {!loaded && <ProgressLine label={`Loading ${title}`} />}
      {src === null ? (
        <ErrorState error={new Error(`${title} has an invalid address.`)} compact />
      ) : null}
      {error ? (
        <ErrorState
          error={new Error(`${title} couldn’t sign in. ${errorMessage(error)}`)}
          onRetry={() => {
            setLoaded(false);
            setAttempt((a) => a + 1);
          }}
          compact
        />
      ) : null}
      {src !== null && (
        <iframe
          key={`${src}#${attempt}`}
          ref={frame}
          src={src}
          title={title}
          className="module-frame-iframe"
          // Its own origin (the gateway), scripts and forms; no top navigation.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          referrerPolicy="no-referrer"
          onLoad={() => {
            setLoaded(true);
            post({ type: 'clerq:theme', theme: resolvedTheme(theme) });
            void sendToken();
          }}
        />
      )}
    </div>
  );
}
