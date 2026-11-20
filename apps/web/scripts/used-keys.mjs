// Lists every translation key used in the source: `useTranslations('ns')` bound to a variable, then `t('key')` / t(`prefix.${x}`).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const files = walk('src').filter((f) => /\.tsx$/.test(f) && !f.includes('/generated/'));
const keys = new Set();
const dynamic = new Set();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const bindings = [...text.matchAll(/const (\w+) = useTranslations\('([\w.]+)'\)/g)].map((m) => ({ v: m[1], ns: m[2] }));
  for (const { v, ns } of bindings) {
    for (const m of text.matchAll(new RegExp(`\\b${v}\\(\\s*'([\\w.]+)'`, 'g'))) keys.add(`${ns}.${m[1]}`);
    for (const m of text.matchAll(new RegExp(`\\b${v}\\(\\s*\`([\\w.]+)\\$\\{`, 'g'))) dynamic.add(`${ns}.${m[1]}*`);
    for (const m of text.matchAll(new RegExp(`\\b${v}\\(\\s*(\\w+)\\)`, 'g'))) dynamic.add(`${ns}.<${m[1]}>`);
  }
}
console.log(JSON.stringify({ keys: [...keys].sort(), dynamic: [...dynamic].sort() }, null, 1));
