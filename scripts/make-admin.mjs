// Creates (or resets) an admin account in your D1 database.
//
//   npm run admin:local  -- you@school.com "your password"     (database on your computer)
//   npm run admin:remote -- you@school.com "your password"     (database on Cloudflare)
//
// The password is hashed here with the same method the Worker uses, so it is never stored as plain text.

import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const target = args.includes('--remote') ? '--remote' : '--local';
const [email, password] = args.filter((a) => !a.startsWith('--'));

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
  console.error('That does not look like an email address: ' + JSON.stringify(email));
  console.error('Usage: npm run admin:local -- you@school.com "a password of 8+ characters"');
  process.exit(1);
}
if (!password || password.length < 8) {
  console.error('The password must be at least 8 characters.');
  console.error('Usage: npm run admin:local -- you@school.com "a password of 8+ characters"');
  process.exit(1);
}

const ITERATIONS = 100_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const stored = `pbkdf2$${ITERATIONS}$${salt.toString('base64')}$${hash.toString('base64')}`;

const q = (s) => `'${s.replaceAll("'", "''")}'`;
const sql =
  `INSERT INTO admins (email, password_hash) VALUES (${q(email.trim().toLowerCase())}, ${q(stored)}) ` +
  `ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash;`;

// Put the SQL in a temporary file (avoids Windows quoting problems) and run Wrangler with Node directly.
const dir = mkdtempSync(join(tmpdir(), 'cbt-admin-'));
const file = join(dir, 'admin.sql');
writeFileSync(file, sql);

try {
  const wranglerBin = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  execFileSync(process.execPath, [wranglerBin, 'd1', 'execute', 'damiland-cbt', target, '--file', file], {
    stdio: 'inherit',
  });
  console.log(`\nAdmin ready: ${email.trim().toLowerCase()} (${target === '--remote' ? 'Cloudflare' : 'your computer'})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
