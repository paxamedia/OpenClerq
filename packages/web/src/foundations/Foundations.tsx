/**
 * Foundations: the colours, type, spacing, icons and components on one page, in
 * either theme, for checking the design system while the interface is built.
 * The desktop dev server serves it at /foundations.html; release builds leave it out.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock,
  Command,
  GitBranch,
  GitPullRequest,
  History,
  House,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Square,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';
import { SegmentedControl } from '../ui/Choice';
import { Icon } from '../ui/Icon';
import { ToastProvider } from '../ui/Toast';
import { contrastRatio } from '../ui/contrast';
import { ComponentsDemo } from './ComponentsDemo';
import './foundations.css';

type Theme = 'auto' | 'light' | 'dark';

/** Shared with the desktop app, so the page opens in the theme the app uses. */
const THEME_KEY = 'clerq-theme';

const COLOURS: Array<[token: string, use: string]> = [
  ['--bg', 'Page'],
  ['--surface', 'Panels, tables, inputs'],
  ['--surface-2', 'Hover, selected row, code'],
  ['--line', 'Dividers, borders'],
  ['--line-strong', 'Inputs, overlays'],
  ['--ink', 'Text'],
  ['--ink-2', 'Secondary text'],
  ['--ink-3', 'Labels, metadata'],
  ['--accent', 'Primary action, focus, running'],
  ['--accent-hover', 'Primary action on hover'],
  ['--on-accent', 'Text on accent'],
  ['--accent-weak', 'Selected nav, accent fills'],
  ['--ok', 'Done, passed'],
  ['--warn', 'Needs approval, warnings'],
  ['--err', 'Failed, errors'],
];

/** Colours used for text, checked against the surface they sit on. */
const TEXT_ON = new Map([
  ['--ink', '--surface'],
  ['--ink-2', '--surface'],
  ['--ink-3', '--surface'],
  ['--accent', '--surface'],
  ['--on-accent', '--accent'],
  ['--ok', '--surface'],
  ['--warn', '--surface'],
  ['--err', '--surface'],
]);

const TYPE: Array<[role: string, spec: string, sample: string]> = [
  ['page', 'Page title · 20/28 · 600', 'Automations'],
  ['section', 'Section title · 15/22 · 600', 'Next runs'],
  ['body', 'Body · 14/20 · 400', 'Runs every Monday at 08:00 and opens a draft pull request.'],
  ['secondary', 'Secondary · 13/18 · 400', 'Last run 2 min ago · $0.42'],
  ['label', 'Label · 12/16 · 500', 'Spend this month'],
  ['kpi', 'KPI · mono 28/32 · 500', '$4.20'],
  ['code', 'Code · mono 13/20 · 400', 'pnpm test --frozen-lockfile'],
];

const SPACE = [1, 2, 3, 4, 6, 8, 12];

const ICONS: Array<[name: string, glyph: LucideIcon]> = [
  ['Home', House],
  ['Automations', Workflow],
  ['Runs', History],
  ['Approvals', ShieldCheck],
  ['Chat', MessageSquare],
  ['Developer', SquareTerminal],
  ['Settings', Settings],
  ['Search', Search],
  ['Palette', Command],
  ['Run now', Play],
  ['Pause', Pause],
  ['Stop', Square],
  ['New', Plus],
  ['Delete', Trash2],
  ['Done', Check],
  ['Close', X],
  ['Warning', TriangleAlert],
  ['Schedule', Clock],
  ['Branch', GitBranch],
  ['Pull request', GitPullRequest],
  ['Open', ArrowUpRight],
  ['Next', ChevronRight],
];

function readStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

function readTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(COLOURS.map(([t]) => [t, style.getPropertyValue(t).trim()]));
}

function ratio(fg: string | undefined, bg: string | undefined): string {
  try {
    return fg && bg ? `${contrastRatio(fg, bg).toFixed(1)}:1` : '';
  } catch {
    return '';
  }
}

export function Foundations() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [tokens, setTokens] = useState<Record<string, string>>({});

  const refresh = useCallback(() => setTokens(readTokens()), []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage can be unavailable; the theme still applies for this page.
    }
    refresh();
  }, [theme, refresh]);

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', refresh);
    return () => media.removeEventListener('change', refresh);
  }, [refresh]);

  return (
    <ToastProvider>
      <main className="fdn">
        <header className="fdn-head">
          <div>
            <h1 className="fdn-title">Foundations</h1>
            <p className="fdn-sub">
              Tokens, type, icons and components for the OpenClerq interface.
            </p>
          </div>
          <SegmentedControl
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'auto', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </header>

        <section className="fdn-section">
          <h2 className="fdn-label">Colour</h2>
          <ul className="fdn-swatches">
            {COLOURS.map(([token, use]) => (
              <li key={token} className="fdn-swatch">
                <span className="fdn-chip" data-token={token} />
                <code className="fdn-token">{token}</code>
                <span className="fdn-meta">{use}</span>
                <span className="fdn-meta fdn-mono">
                  {tokens[token]}
                  {TEXT_ON.has(token) && ` · ${ratio(tokens[token], tokens[TEXT_ON.get(token)!])}`}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="fdn-section">
          <h2 className="fdn-label">Type</h2>
          <dl className="fdn-type">
            {TYPE.map(([role, spec, sample]) => (
              <div key={role} className="fdn-type-row">
                <dt className="fdn-meta">{spec}</dt>
                <dd className="fdn-type-sample" data-role={role}>
                  {sample}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="fdn-section">
          <h2 className="fdn-label">Space</h2>
          <ul className="fdn-space">
            {SPACE.map((step) => (
              <li key={step} className="fdn-space-row">
                <span className="fdn-space-bar" data-step={step} />
                <span className="fdn-meta fdn-mono">--space-{step}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="fdn-section">
          <h2 className="fdn-label">Icons · 16 px · stroke 1.5 · square caps</h2>
          <ul className="fdn-icons">
            {ICONS.map(([name, glyph]) => (
              <li key={name} className="fdn-icon">
                <Icon glyph={glyph} />
                <span className="fdn-meta">{name}</span>
              </li>
            ))}
          </ul>
        </section>

        <ComponentsDemo />
      </main>
    </ToastProvider>
  );
}
