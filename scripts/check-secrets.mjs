// Cheap CI guard: committed files must not contain private keys or obviously hard-coded credentials.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
const patterns = [
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:secret|password|token)\s*[:=]\s*['"][A-Za-z0-9+/_-]{24,}['"]/i,
];
const allowed = new Set(['.env.example', 'scripts/check-secrets.mjs']);
// Test files carry obviously fake fixtures (dummy passwords, throw-away signing keys).
const isTest = (file) => /(^|\/)test\//.test(file) || /\.test\.ts$/.test(file);
let failed = false;
for (const file of files) {
  if (allowed.has(file) || isTest(file) || /\.(png|jpg|svg|lock|yaml)$/.test(file) || file.endsWith('pnpm-lock.yaml')) continue;
  const text = readFileSync(file, 'utf8');
  for (const re of patterns) {
    if (re.test(text)) {
      process.stderr.write(`possible secret in ${file}: ${re}\n`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
process.stdout.write(`secret scan ok (${files.length} files)\n`);
