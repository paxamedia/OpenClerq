/**
 * Guards for the design rules. Each failure names the file and line, so a
 * rounded corner or a stray colour is caught in CI rather than in review.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './ui/contrast';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const TOKENS = path.join(SRC, 'ui', 'tokens.css');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]
  );
}

const all = sourceFiles(SRC);
const cssFiles = all.filter((f) => f.endsWith('.css'));
const codeFiles = all.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

const where = (file: string, line: number) => `${path.relative(SRC, file)}:${line}`;

/** Comments blanked out, newlines kept, so line numbers still match the file. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
}

interface Declaration {
  prop: string;
  value: string;
  line: number;
}

function declarations(css: string): Declaration[] {
  const text = stripComments(css);
  return [...text.matchAll(/([a-z0-9-]+)\s*:\s*([^;{}]+);/g)].map((m) => ({
    prop: m[1],
    value: m[2].trim(),
    line: text.slice(0, m.index).split('\n').length,
  }));
}

interface Rule {
  selector: string;
  media?: string;
  values: Record<string, string>;
}

function rules(css: string): Rule[] {
  const out: Rule[] = [];
  const walk = (text: string, media?: string) => {
    let i = 0;
    for (let open = text.indexOf('{', i); open >= 0; open = text.indexOf('{', i)) {
      let depth = 1;
      let close = open + 1;
      for (; depth > 0 && close < text.length; close++) {
        if (text[close] === '{') depth++;
        else if (text[close] === '}') depth--;
      }
      const head = text.slice(i, open).trim();
      const body = text.slice(open + 1, close - 1);
      if (head.startsWith('@media')) walk(body, head);
      else {
        const values = Object.fromEntries(declarations(body).map((d) => [d.prop, d.value]));
        out.push({ selector: head, media, values });
      }
      i = close;
    }
  };
  walk(stripComments(css));
  return out;
}

describe('shape', () => {
  it('keeps every corner at 1px or less', () => {
    const allowed = new Set(['0', '0px', '1px', 'var(--radius)', 'var(--radius-control)']);
    const found = cssFiles.flatMap((file) =>
      declarations(readFileSync(file, 'utf8'))
        .filter((d) => /^border(-[a-z]+)*-radius$/.test(d.prop))
        .filter((d) => !d.value.split(/\s+/).every((v) => allowed.has(v)))
        .map((d) => `${where(file, d.line)} ${d.prop}: ${d.value}`)
    );
    expect(found).toEqual([]);
  });

  it('defines the radius tokens as 0 and 1px', () => {
    const root = rules(readFileSync(TOKENS, 'utf8')).find(
      (r) => r.selector === ':root' && !r.media
    );
    expect(root?.values['--radius']).toBe('0');
    expect(root?.values['--radius-control']).toBe('1px');
  });

  it('uses no shadows or gradients', () => {
    const found = cssFiles.flatMap((file) =>
      declarations(readFileSync(file, 'utf8'))
        .filter(
          (d) =>
            (/^(box|text)-shadow$/.test(d.prop) && d.value !== 'none') || /gradient\(/.test(d.value)
        )
        .map((d) => `${where(file, d.line)} ${d.prop}: ${d.value}`)
    );
    expect(found).toEqual([]);
  });
});

describe('styles stay in stylesheets', () => {
  it('has no inline style props in components', () => {
    const found = codeFiles.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((text, i) => (/\bstyle\s*=\s*\{/.test(text) ? [where(file, i + 1)] : []))
    );
    expect(found).toEqual([]);
  });

  it('names colours only in tokens.css', () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
    const named =
      /\b(white|black|red|green|blue|gr[ae]y|orange|yellow|purple|pink|brown|silver|gold|navy|teal)\b/i;
    const colourProp = /color|background|border|outline|fill|stroke|shadow|caret|decoration/;
    const inCss = cssFiles
      .filter((file) => file !== TOKENS)
      .flatMap((file) =>
        declarations(readFileSync(file, 'utf8'))
          .filter((d) => literal.test(d.value) || (colourProp.test(d.prop) && named.test(d.value)))
          .map((d) => `${where(file, d.line)} ${d.prop}: ${d.value}`)
      );
    const inCode = codeFiles.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((text, i) =>
          /['"`](#[0-9a-f]{3,8}|(rgba?|hsla?|oklch)\()/i.test(text) ? [where(file, i + 1)] : []
        )
    );
    expect([...inCss, ...inCode]).toEqual([]);
  });

  it('names fonts only in tokens.css', () => {
    const found = cssFiles
      .filter((file) => file !== TOKENS)
      .flatMap((file) =>
        declarations(readFileSync(file, 'utf8'))
          .filter(
            (d) =>
              (d.prop === 'font-family' && !/^(var\(--font-[a-z]+\)|inherit)$/.test(d.value)) ||
              (d.prop === 'font' && !/^(var\(--type-[a-z]+\)|inherit)$/.test(d.value))
          )
          .map((d) => `${where(file, d.line)} ${d.prop}: ${d.value}`)
      );
    expect(found).toEqual([]);
  });
});

describe('colour tokens', () => {
  const tokenRules = rules(readFileSync(TOKENS, 'utf8'));
  const colours = (r: Rule | undefined) =>
    Object.fromEntries(Object.entries(r?.values ?? {}).filter(([k]) => k.startsWith('--')));
  const light = colours(tokenRules.find((r) => r.selector.includes("[data-theme='light']")));
  const darkAuto = colours(tokenRules.find((r) => r.media?.includes('prefers-color-scheme: dark')));
  const darkForced = colours(tokenRules.find((r) => r.selector === ":root[data-theme='dark']"));

  it('keeps the system dark theme and the forced dark theme identical', () => {
    expect(Object.keys(darkAuto).length).toBeGreaterThan(0);
    expect(darkAuto).toEqual(darkForced);
  });

  it('defines the same colours in light and dark', () => {
    expect(Object.keys(darkForced).sort()).toEqual(Object.keys(light).sort());
  });

  it('meets WCAG AA (4.5:1) for text and state colours in both themes', () => {
    const text = ['--ink', '--ink-2', '--ink-3', '--accent', '--ok', '--warn', '--err'];
    const pairs: Array<[string, string]> = [
      ...text.flatMap(
        (fg): Array<[string, string]> => [
          [fg, '--bg'],
          [fg, '--surface'],
        ]
      ),
      ['--on-accent', '--accent'],
    ];
    const failures = Object.entries({ light, dark: darkForced }).flatMap(([theme, values]) =>
      pairs
        .map(([fg, bg]) => ({ fg, bg, ratio: contrastRatio(values[fg], values[bg]) }))
        .filter((p) => p.ratio < 4.5)
        .map((p) => `${theme}: ${p.fg} on ${p.bg} is ${p.ratio.toFixed(2)}:1`)
    );
    expect(failures).toEqual([]);
  });
});
