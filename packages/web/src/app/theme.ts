/**
 * Light, dark or the system's choice, stored per device. The index.html of each
 * app reads the same key before React starts, so the first paint is right.
 */

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'auto' | 'light' | 'dark';

export const THEME_KEY = 'clerq-theme';

export function storedTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

const listeners = new Set<(t: Theme) => void>();

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    if (theme === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode: the choice lasts for this window */
  }
  listeners.forEach((fn) => fn(theme));
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(storedTheme);
  useEffect(() => {
    listeners.add(set);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return [theme, useCallback((t: Theme) => setTheme(t), [])];
}
