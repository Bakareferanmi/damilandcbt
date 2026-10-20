import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { transform } from 'esbuild';

test('every inline page script parses, including module imports and nested admin templates', async () => {
  for (const file of readdirSync('public').filter((p) => p.endsWith('.html'))) {
    const html = readFileSync('public/' + file, 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      if (match[1].trim()) await transform(match[1], { sourcefile: file, loader: 'js', format: 'esm' });
    }
  }
});
