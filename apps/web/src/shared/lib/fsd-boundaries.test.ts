// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '../../../../..');

/** The plugin classifies real files by path, so each case is written to disk, linted and removed again. */
const lint = async (filePath: string, code: string): Promise<string[]> => {
  const absolute = resolve(repo, filePath);
  writeFileSync(absolute, code);
  try {
    let stdout = '';
    try {
      stdout = execFileSync('pnpm', ['exec', 'eslint', '--format', 'json', absolute], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      stdout = (error as { stdout?: string }).stdout ?? '';
    }
    const [result] = JSON.parse(stdout) as { messages: { ruleId: string | null; message: string }[] }[];
    return (result?.messages ?? []).filter((m) => m.ruleId?.startsWith('boundaries/')).map((m) => `${m.ruleId}: ${m.message}`);
  } finally {
    rmSync(absolute, { force: true });
  }
};

describe('Feature-Sliced Design boundaries are enforced by lint', () => {
  it('a lower layer cannot import from a higher one (entity -> feature)', async () => {
    const errors = await lint('apps/web/src/entities/order/ui/fsd-fixture.tsx', "import { LoginForm } from '@/features/auth';\nexport const X = LoginForm;\n");
    expect(errors.join('\n')).toContain('boundaries/element-types');
  });

  it('shared cannot import business layers', async () => {
    const errors = await lint('apps/web/src/shared/ui/fsd-fixture.tsx', "import { useMyOrders } from '@/entities/order';\nexport const X = useMyOrders;\n");
    expect(errors.join('\n')).toContain('boundaries/element-types');
  });

  it('slices of the same layer cannot import each other', async () => {
    const errors = await lint('apps/web/src/features/order-actions/ui/fsd-fixture.tsx', "import { LoginForm } from '@/features/auth';\nexport const X = LoginForm;\n");
    expect(errors.join('\n')).toContain('boundaries/element-types');
  });

  it('a slice may only be imported through its public API', async () => {
    const errors = await lint('apps/web/src/widgets/event-booking/ui/fsd-fixture.tsx', "import { PromoForm } from '@/features/order-actions/ui/promo-form';\nexport const X = PromoForm;\n");
    expect(errors.join('\n')).toContain('boundaries/entry-point');
  });

  it('the allowed direction through the public API is clean', async () => {
    const errors = await lint('apps/web/src/widgets/event-booking/ui/fsd-fixture-good.tsx', "import { PromoForm } from '@/features/order-actions';\nimport { useMyOrders } from '@/entities/order';\nexport const X = [PromoForm, useMyOrders];\n");
    expect(errors).toEqual([]);
  });
});
