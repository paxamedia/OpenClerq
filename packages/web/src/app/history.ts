/**
 * The back stack across pages and modules. The browser's own history moves;
 * this remembers what each entry was called, so the top bar can say where
 * Back goes ("Back to Runs") when it leaves the current module.
 */

import { useEffect, useState } from 'react';

export interface Visit {
  path: string;
  title: string;
}

const KEY = 'clerq-back-stack';
const LIMIT = 50;

/** What the browser keeps on each history entry: where it sits in the stack. */
interface Mark {
  clerqIndex: number;
}

/** The part of `window.history` this module uses. */
export interface Nav {
  state: unknown;
  replaceState(state: unknown, unused: string): void;
}

let stack: Array<Visit | null> = load();
let current = -1;
const listeners = new Set<() => void>();

function load(): Array<Visit | null> {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Array<Visit | null>) : [];
  } catch {
    return [];
  }
}

function save(): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(stack));
  } catch {
    /* in memory only */
  }
  listeners.forEach((fn) => fn());
}

/** The page or module a path belongs to: "runs", "m/crm". */
export function areaOf(path: string): string {
  const [first, second] = path.split('?')[0].split('/').filter(Boolean);
  if (!first) return 'home';
  return first === 'm' && second ? `m/${second}` : first;
}

const markOf = (state: unknown): number | null => {
  const i = (state as Partial<Mark> | null)?.clerqIndex;
  return typeof i === 'number' && Number.isInteger(i) && i >= 0 ? i : null;
};

/**
 * Record a route change. Every history entry carries its index in `history.state`,
 * so the entry before this one is the one Back reaches, whatever the paths are:
 * an entry with no index is a new page (pushed after the current one), the same
 * index is a replace, and any other index is the user moving through history.
 */
export function visit(path: string, nav: Nav = window.history): void {
  const at = markOf(nav.state);
  if (at === null) {
    current += 1;
    stack = [...stack.slice(0, current), { path, title: '' }];
    nav.replaceState({ ...(nav.state as object | null), clerqIndex: current } satisfies Mark, '');
    if (current >= LIMIT) stack[current - LIMIT] = null;
  } else if (at === current) {
    if (stack[at]?.path === path) return;
    stack[at] = { path, title: '' };
  } else {
    current = at;
    if (stack[at]?.path !== path) stack[at] = { path, title: '' };
    else return save();
  }
  save();
}

/** Name the current page, as its header does. */
export function nameCurrent(path: string, title: string): void {
  const top = stack[current];
  if (!top || top.path !== path || top.title === title) return;
  stack = stack.map((v, i) => (i === current ? { path, title } : v));
  save();
}

/** Where Back goes from `path`, when it leaves the current page's area. */
export function backTargetOf(path: string): Visit | null {
  const top = stack[current];
  const prev = current > 0 ? stack[current - 1] : null;
  if (!top || top.path !== path || !prev || !prev.title) return null;
  return areaOf(prev.path) !== areaOf(path) ? prev : null;
}

export function useBackTarget(path: string): Visit | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return backTargetOf(path);
}

export function resetHistory(): void {
  stack = [];
  current = -1;
  save();
}
