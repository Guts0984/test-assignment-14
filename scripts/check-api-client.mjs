// Regenerates the OpenAPI document and the web client, then fails if the tree changed.
// Becomes active once apps/api defines `gen:openapi` (commit C5) and web defines `gen:client` (commit C9).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const hasScript = (pkg, name) => {
  try {
    return Boolean(JSON.parse(readFileSync(`${pkg}/package.json`, 'utf8')).scripts?.[name]);
  } catch {
    return false;
  }
};
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

if (!hasScript('apps/api', 'gen:openapi')) {
  process.stdout.write('api-client check: no OpenAPI emitter yet (added in C5) - nothing to compare\n');
  process.exit(0);
}
run('pnpm --filter @ticketing/api gen:openapi');
if (hasScript('apps/web', 'gen:client')) run('pnpm --filter @ticketing/web gen:client');
try {
  run('git diff --exit-code -- apps/api/openapi.json apps/web/src/shared/api/generated');
  process.stdout.write('api-client check: generated artifacts match the committed ones\n');
} catch {
  process.stderr.write('api-client check FAILED: regenerate (pnpm gen) and commit the result\n');
  process.exit(1);
}
