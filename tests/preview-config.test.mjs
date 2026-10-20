import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';

async function config(path) {
  // Repository-owned JSONC object literals include comments. Wrangler performs
  // schema validation; this test checks the resolved binding IDs and targets.
  const { code } = await transform('export default ' + readFileSync(path, 'utf8'), { loader: 'js', format: 'esm' });
  return (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).default;
}

test('preview deployment and migrations target the same separate database', async () => {
  const main = await config('wrangler.jsonc');
  const migrations = await config('wrangler.preview-migrations.jsonc');
  const production = main.d1_databases.find((x) => x.binding === 'DB');
  const preview = main.previews.d1_databases.find((x) => x.binding === 'DB');
  const target = migrations.d1_databases.find((x) => x.binding === 'PREVIEW_DB');
  assert.equal(production.database_id, 'f9ba1870-690b-4403-8263-4f418b14830a');
  assert.equal(preview.database_id, '11bd3e91-0ff7-4f70-b29f-2187fe1255f5');
  assert.notEqual(preview.database_id, production.database_id);
  assert.equal(target.database_id, preview.database_id);
  assert.equal(target.database_name, preview.database_name);
  assert.equal(target.migrations_dir, 'migrations');
});
