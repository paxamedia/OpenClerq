/**
 * A small hash router. Every page is a route (`#/runs/abc123`), so any view
 * can be linked, Back works, and the phone app's deep links land on the same
 * paths. Query parameters after the path hold filters: `#/runs?status=failed`.
 */

import { useCallback, useEffect, useState, type AnchorHTMLAttributes } from 'react';

export interface Route {
  /** The path without the leading `#`, e.g. "/runs/abc123". */
  path: string;
  segments: string[];
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  return { path, segments, query: new URLSearchParams(queryPart) };
}

/** A path built from parts, each encoded: `href('runs', id)` → "/runs/abc". */
export function href(...parts: Array<string | number>): string {
  return `/${parts.map((p) => encodeURIComponent(String(p))).join('/')}`;
}

export function withQuery(path: string, query: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  const hash = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (window.location.hash === hash) return;
  if (opts.replace) {
    window.history.replaceState(null, '', hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;
  }
}

export function useRoute(): Route {
  const read = () => parseHash(typeof window === 'undefined' ? '' : window.location.hash);
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/** Change one query parameter of the current route without adding a history entry. */
export function useQueryParam(name: string): [string | null, (value: string | null) => void] {
  const route = useRoute();
  const value = route.query.get(name);
  const set = useCallback(
    (next: string | null) => {
      const current = parseHash(window.location.hash);
      const q = new URLSearchParams(current.query);
      if (next) q.set(name, next);
      else q.delete(name);
      const s = q.toString();
      navigate(s ? `${current.path}?${s}` : current.path, { replace: true });
    },
    [name]
  );
  return [value, set];
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
}

/** A link to a route: a plain anchor, so modified clicks and Back behave as usual. */
export function Link({ to, ...rest }: LinkProps) {
  return <a href={`#${to}`} {...rest} />;
}

/** Whether `path` is `base` or a page under it. */
export function isUnder(path: string, base: string): boolean {
  if (base === '/') return path === '/';
  return path === base || path.startsWith(`${base}/`);
}
