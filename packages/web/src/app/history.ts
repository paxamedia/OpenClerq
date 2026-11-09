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

let stack: Visit[] = load();
const listeners = new Set<() => void>();

function load(): Visit[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Visit[]) : [];
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

/** Record a route change: Back pops, anything else pushes. */
export function visit(path: string): void {
  const top = stack[stack.length - 1];
  if (top?.path === path) return;
  const prev = stack[stack.length - 2];
  if (prev?.path === path) stack = stack.slice(0, -1);
  else stack = [...stack, { path, title: '' }].slice(-LIMIT);
  save();
}

/** Name the current page, as its header does. */
export function nameCurrent(path: string, title: string): void {
  const top = stack[stack.length - 1];
  if (!top || top.path !== path || top.title === title) return;
  stack = [...stack.slice(0, -1), { path, title }];
  save();
}

/** Where Back goes, when it leaves the current page's area. */
export function useBackTarget(path: string): Visit | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  const top = stack[stack.length - 1];
  const prev = stack[stack.length - 2];
  if (!top || top.path !== path || !prev || !prev.title) return null;
  return areaOf(prev.path) !== areaOf(path) ? prev : null;
}

export function resetHistory(): void {
  stack = [];
  save();
}
