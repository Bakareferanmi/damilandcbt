// One-off cleanup for the 100 production accounts inspected on 20 October 2026.
// From the project directory:
//   node scripts/remove-loadtest-20261020.mjs            (read-only preview)
//   node scripts/remove-loadtest-20261020.mjs --delete   (backup, then cleanup)
// The Load100 exam and its questions are retained. No Worker deployment is needed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const target = `session_id = 1
  AND code BETWEEN 'DAMILANDCBT004' AND 'DAMILANDCBT103'
  AND full_name GLOB 'Loadtest 3 Student [0-9][0-9][0-9]'
  AND CAST(substr(full_name, -3) AS INTEGER) BETWEEN 1 AND 100`;
const students = `SELECT id FROM students WHERE ${target}`;
const attempts = `SELECT id FROM attempts WHERE student_id IN (${students})`;

// Wrangler can write JSON errors to stdout. Preserve those errors when the
// command fails instead of displaying a long SQL command with no explanation.
export function invokeWrangler(cli, args, config, root, capture = false, execute = execFileSync) {
  try {
    return execute(process.execPath, [cli, ...args, '--config', config], {
      cwd: root, encoding: 'utf8', stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const output = [error.stdout, error.stderr]
      .map((value) => value == null ? '' : String(value).trim()).filter(Boolean).join('\n');
    throw new Error(`Wrangler failed during ${args.slice(0, 2).join(' ')}.\n${output || `Process exited with status ${error.status ?? error.code ?? 'unknown'}.`}`);
  }
}

export const previewSql = `SELECT
  (SELECT COUNT(*) FROM students WHERE ${target}) AS testStudents,
  (SELECT COUNT(DISTINCT full_name) FROM students WHERE ${target}) AS distinctNames,
  (SELECT COUNT(*) FROM attempts WHERE student_id IN (${students}) AND exam_id = 3 AND submitted_at IS NOT NULL) AS completedTestAttempts,
  (SELECT COUNT(*) FROM attempts WHERE submitted_at IS NULL) AS activeAttempts,
  (SELECT COUNT(*) FROM attempts WHERE student_id IN (${students}) AND exam_id <> 3) AS otherExamAttempts,
  (SELECT COUNT(*) FROM attempt_archives WHERE student_id IN (${students}) AND exam_id <> 3) AS otherExamArchives,
  (SELECT COUNT(*) FROM exams WHERE id = 3 AND session_id = 1 AND name = 'Load100 2026-10-20T14:00') AS matchingExam,
  (SELECT COUNT(*) FROM settings WHERE key = 'current_exam_id' AND CAST(value AS INTEGER) <> 3) AS testExamNotLive,
  (SELECT COUNT(*) FROM students WHERE NOT (${target})) AS protectedStudents,
  (SELECT COUNT(*) FROM answers WHERE attempt_id IN (${attempts})) AS testAnswers,
  (SELECT COUNT(*) FROM scores WHERE attempt_id IN (${attempts})) AS testScores;`;

// CHECK constraints stop this file before any deletion if the batch has changed.
// The guard also checks preserved records again before finishing.
export const cleanupSql = `
CREATE TABLE cleanup_loadtest_20261020_guard (
  ok INTEGER NOT NULL CHECK (ok = 1),
  protected_students INTEGER NOT NULL,
  protected_attempts INTEGER NOT NULL,
  protected_answers INTEGER NOT NULL,
  protected_scores INTEGER NOT NULL,
  protected_archives INTEGER NOT NULL,
  questions INTEGER NOT NULL,
  exams INTEGER NOT NULL
);
INSERT INTO cleanup_loadtest_20261020_guard
SELECT CASE WHEN
  (SELECT COUNT(*) FROM students WHERE ${target}) = 100
  AND (SELECT COUNT(DISTINCT full_name) FROM students WHERE ${target}) = 100
  AND (SELECT COUNT(*) FROM attempts WHERE student_id IN (${students}) AND exam_id = 3 AND submitted_at IS NOT NULL) = 100
  AND NOT EXISTS (SELECT 1 FROM attempts WHERE submitted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM attempts WHERE student_id IN (${students}) AND exam_id <> 3)
  AND NOT EXISTS (SELECT 1 FROM attempt_archives WHERE student_id IN (${students}) AND exam_id <> 3)
  AND EXISTS (SELECT 1 FROM exams WHERE id = 3 AND session_id = 1 AND name = 'Load100 2026-10-20T14:00')
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'current_exam_id' AND CAST(value AS INTEGER) <> 3)
  THEN 1 ELSE 0 END,
  (SELECT COUNT(*) FROM students WHERE NOT (${target})),
  (SELECT COUNT(*) FROM attempts WHERE student_id NOT IN (${students})),
  (SELECT COUNT(*) FROM answers WHERE attempt_id NOT IN (${attempts})),
  (SELECT COUNT(*) FROM scores WHERE attempt_id NOT IN (${attempts})),
  (SELECT COUNT(*) FROM attempt_archives WHERE student_id NOT IN (${students})),
  (SELECT COUNT(*) FROM questions),
  (SELECT COUNT(*) FROM exams);

DELETE FROM answers WHERE attempt_id IN (${attempts});
DELETE FROM scores WHERE attempt_id IN (${attempts});
DELETE FROM attempt_archives WHERE student_id IN (${students});
DELETE FROM attempts WHERE student_id IN (${students});
DELETE FROM login_attempts WHERE EXISTS (
  SELECT 1 FROM students WHERE ${target}
    AND (login_attempts.key = 's:' || students.code
      OR substr(login_attempts.key, 1, length('s:' || students.code || ':')) = 's:' || students.code || ':')
);
DELETE FROM students WHERE ${target};

UPDATE cleanup_loadtest_20261020_guard SET ok = CASE WHEN
  NOT EXISTS (SELECT 1 FROM students WHERE ${target})
  AND protected_students = (SELECT COUNT(*) FROM students)
  AND protected_attempts = (SELECT COUNT(*) FROM attempts)
  AND protected_answers = (SELECT COUNT(*) FROM answers)
  AND protected_scores = (SELECT COUNT(*) FROM scores)
  AND protected_archives = (SELECT COUNT(*) FROM attempt_archives)
  AND questions = (SELECT COUNT(*) FROM questions)
  AND exams = (SELECT COUNT(*) FROM exams)
  THEN 1 ELSE 0 END;
SELECT 'Removed 100 virtual students and their test attempts, answers and scores.' AS result,
       protected_students AS remainingStudents FROM cleanup_loadtest_20261020_guard;
DROP TABLE cleanup_loadtest_20261020_guard;
`;

function main() {
  const flags = process.argv.slice(2);
  if (flags.some((arg) => arg !== '--delete') || flags.length > 1) throw new Error('Use no arguments to preview, or --delete to back up and remove this test batch.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cli = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(cli)) throw new Error('Run npm ci in the project directory first.');
  const backups = join(root, 'backups'); // Already excluded by this repository's .gitignore.
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const config = join(backups, 'cleanup-loadtest-20261020.config.json');
  writeFileSync(config, JSON.stringify({
    name: 'damiland-cbt-cleanup',
    d1_databases: [{ binding: 'DB', database_name: 'damiland-cbt', database_id: 'f9ba1870-690b-4403-8263-4f418b14830a' }],
  }, null, 2), { mode: 0o600 });
  const run = (args, capture = false) => invokeWrangler(cli, args, config, root, capture);
  const query = (sql) => {
    const output = run(['d1', 'execute', 'DB', '--remote', '--command', sql, '--json'], true);
    let response;
    try { response = JSON.parse(output); }
    catch { throw new Error(`D1 did not return JSON. Wrangler output:\n${output.trim()}`); }
    if (!Array.isArray(response) || !response.length || response.some((r) => r.success === false)) throw new Error(`D1 did not return a successful query result:\n${JSON.stringify(response, null, 2)}`);
    return response.flatMap((r) => r.results ?? []);
  };
  const [before] = query(previewSql);
  if (!before) throw new Error('Could not inspect the test batch.');
  console.table([before]);
  if (!flags.includes('--delete')) {
    console.log('Preview only. To export a backup and delete exactly this batch, run this command again with --delete.');
    return;
  }
  if (before.testStudents === 0) { console.log('No matching virtual students remain. Nothing was changed.'); return; }
  if (before.testStudents !== 100 || before.distinctNames !== 100 || before.completedTestAttempts !== 100
      || before.activeAttempts !== 0 || before.otherExamAttempts !== 0 || before.otherExamArchives !== 0
      || before.matchingExam !== 1 || before.testExamNotLive !== 1) {
    throw new Error('The verified 100-student batch no longer matches, the test exam is live, or an exam is running. Nothing was deleted.');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(backups, `before-loadtest-cleanup-${stamp}.sql`);
  console.log('Exporting the production database before deletion.');
  run(['d1', 'export', 'DB', '--remote', '--output', backup]);
  if (!existsSync(backup) || statSync(backup).size === 0) throw new Error('No non-empty backup was created. Nothing was deleted.');
  console.log(`Backup saved: ${backup}`);
  const sqlFile = join(backups, `remove-loadtest-${stamp}.sql`);
  writeFileSync(sqlFile, cleanupSql, { mode: 0o600 });
  run(['d1', 'execute', 'DB', '--remote', '--file', sqlFile, '--yes']);
  const [after] = query(previewSql);
  const violations = query('PRAGMA foreign_key_check;');
  if (after?.testStudents !== 0 || after.testAnswers !== 0 || after.testScores !== 0 || violations.length) {
    throw new Error(`Cleanup verification failed. Keep the backup at ${backup} and inspect the database before doing anything else.`);
  }
  console.log(`Verified: all 100 virtual students removed. ${after.protectedStudents} other students remain. Test exam and questions retained.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
