import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';

type Tree = { readonly [key: string]: string | Tree };
const root = resolve(__dirname, '../../..');
const load = (locale: string): Tree => JSON.parse(readFileSync(join(root, 'messages', `${locale}.json`), 'utf8')) as Tree;
const flatten = (tree: Tree, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([k, v]) => (typeof v === 'string' ? [[`${prefix}${k}`, v]] : Object.entries(flatten(v, `${prefix}${k}.`)))));

const locales = ['uk', 'en', 'pl'] as const;
const flat = Object.fromEntries(locales.map((l) => [l, flatten(load(l))])) as Record<(typeof locales)[number], Record<string, string>>;

const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const sources = walk(join(root, 'src')).filter((f) => f.endsWith('.tsx') && !f.includes('/generated/'));

describe('translations', () => {
  it('uk, en and pl have exactly the same keys', () => {
    const keys = (l: (typeof locales)[number]): string[] => Object.keys(flat[l]).sort();
    expect(keys('uk')).toEqual(keys('en'));
    expect(keys('pl')).toEqual(keys('en'));
  });

  it('every key used in the code exists (typos fail here, not in production)', () => {
    const all = new Set(Object.keys(flat.en));
    const missing: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      const namespaces = [...text.matchAll(/const (\w+) = useTranslations\('([\w.]+)'\)/g)].map((m) => ({ v: m[1] ?? '', ns: m[2] ?? '' }));
      for (const { v } of namespaces) {
        const peers = namespaces.filter((n) => n.v === v).map((n) => n.ns);
        for (const m of text.matchAll(new RegExp(`\\b${v}\\(\\s*'([\\w.]+)'`, 'g'))) {
          if (!peers.some((p) => all.has(`${p}.${m[1]}`))) missing.push(`${file.replace(root, '')}: ${v}('${m[1]}') in ${peers.join('|')}`);
        }
        for (const m of text.matchAll(new RegExp(`\\b${v}\\(\\s*\`([\\w.]+)\\$\\{`, 'g'))) {
          if (!peers.some((p) => [...all].some((k) => k.startsWith(`${p}.${m[1]}`)))) missing.push(`${file.replace(root, '')}: ${v}(\`${m[1]}\${…}\`)`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every message is valid ICU and plural forms cover the language', () => {
    for (const l of locales) {
      for (const [key, message] of Object.entries(flat[l])) {
        expect(() => new IntlMessageFormat(message, l), `${l}:${key}`).not.toThrow();
        if (/plural,/.test(message)) {
          const forms = l === 'en' ? ['one', 'other'] : ['one', 'few', 'many', 'other'];
          for (const form of forms) expect(message, `${l}:${key} needs "${form}"`).toContain(`${form} {`);
        }
      }
    }
  });

  const render = (l: (typeof locales)[number], key: string, values: Record<string, string | number>): string => new IntlMessageFormat(flat[l][key] ?? '', l).format(values) as string;

  it('plural forms follow each language ("3 квитки", "5 квитків", "21 квиток")', () => {
    expect([1, 2, 5, 21, 22].map((count) => render('uk', 'order.ticketCount', { count }))).toEqual(['1 квиток', '2 квитки', '5 квитків', '21 квиток', '22 квитки']);
    expect([1, 2, 5, 12, 22].map((count) => render('pl', 'order.ticketCount', { count }))).toEqual(['1 bilet', '2 bilety', '5 biletów', '12 biletów', '22 bilety']);
    expect([1, 2].map((count) => render('en', 'order.ticketCount', { count }))).toEqual(['1 ticket', '2 tickets']);
    expect(render('uk', 'events.found', { count: 3 })).toBe('Знайдено 3 події');
    expect(render('pl', 'booking.selected', { count: 0 })).toBe('Nic nie wybrano');
  });
});
