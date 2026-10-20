import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { cleanupSql, previewSql, invokeWrangler } from '../scripts/remove-loadtest-20261020.mjs';

test('reports the actual Wrangler error from captured stdout and stderr', () => {
  assert.throws(() => invokeWrangler('/cli.js', ['d1', 'execute', '--command', 'SELECT 1'], '/config.json', '/project', true, () => {
    const error = new Error('Command failed: a long command');
    error.status = 1;
    error.stdout = '{"error":"Account selection is required"}';
    error.stderr = 'Select your Cloudflare account.';
    throw error;
  }), (error) => {
    assert.match(error.message, /Account selection is required/);
    assert.match(error.message, /Select your Cloudflare account/);
    assert.doesNotMatch(error.message, /a long command/);
    return true;
  });
});

test('passes Wrangler arguments without a shell and returns successful query output', () => {
  const result = invokeWrangler('C:/Program Files/cli.js', ['d1', 'execute', '--command', 'SELECT 1;'], 'C:/project/config.json', 'C:/project', true, (executable, args, options) => {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, ['C:/Program Files/cli.js', 'd1', 'execute', '--command', 'SELECT 1;', '--config', 'C:/project/config.json']);
    assert.equal(options.shell, undefined);
    assert.deepEqual(options.stdio, ['inherit', 'pipe', 'pipe']);
    return '[{"success":true,"results":[{"ok":1}]}]';
  });
  assert.deepEqual(JSON.parse(result)[0].results, [{ ok: 1 }]);
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const migrations = readdirSync(new URL('../migrations/', import.meta.url)).sort();
  for (const file of migrations.filter((f) => Number(f.slice(0, 4)) < 11)) {
    db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  db.exec(`INSERT INTO exams (id, session_id, name) VALUES (2, 1, 'Mock'), (3, 1, 'Load100 2026-10-20T14:00');
    INSERT INTO admins (email, password_hash) VALUES ('staff@example.test', 'hash');`);
  const insertStudent = db.prepare('INSERT INTO students (id, session_id, seq, code, full_name, class_name, password_hash) VALUES (?, 1, ?, ?, ?, ?, ?)');
  for (let id = 1; id <= 103; id++) {
    // Reverse test names relative to codes; concurrent registrations need not be ordered.
    const name = id < 4 ? 'Existing Student ' + id : 'Loadtest 3 Student ' + String(104 - id).padStart(3, '0');
    insertStudent.run(id, id, 'DAMILANDCBT' + String(id).padStart(3, '0'), name, 'SS3 Science', 'hash-' + id);
  }
  const subjects = db.prepare('SELECT id FROM subjects ORDER BY id').all().map((r) => r.id);
  const questions = db.prepare("INSERT INTO questions (subject_id, body, option_a, option_b, option_c, option_d, correct, session_id, exam_id) VALUES (?, 'Question', 'A', 'B', 'C', 'D', 'A', 1, ?)");
  for (const exam of [1, 3]) for (const subject of subjects) for (let i = 0; i < 50; i++) questions.run(subject, exam);
  const insertAttempt = db.prepare("INSERT INTO attempts (id, student_id, exam_id, group_no, submitted_at) VALUES (?, ?, ?, 2, datetime('now'))");
  const answer = db.prepare("INSERT INTO answers (attempt_id, question_id, chosen) VALUES (?, ?, 'A')");
  const score = db.prepare('INSERT INTO scores (attempt_id, subject_id, score) VALUES (?, ?, 45)');
  insertAttempt.run(1, 1, 1);
  answer.run(1, 1); score.run(1, subjects[0]);
  const ids = db.prepare('SELECT id FROM questions WHERE exam_id = 3 ORDER BY id LIMIT 200').all().map((r) => r.id);
  for (let id = 4; id <= 103; id++) {
    insertAttempt.run(id, id, 3);
    for (const question of ids) answer.run(id, question);
    for (const subject of subjects.slice(0, 4)) score.run(id, subject);
  }
  db.exec(readFileSync(new URL('../migrations/0011_exam_integrity.sql', import.meta.url), 'utf8'));
  db.exec(`INSERT INTO attempt_archives (student_id, exam_id, original_attempt_id, attempt_json, answers_json, scores_json, authorised_by, reason)
      VALUES (4, 3, 10000, '{}', '[]', '[]', 1, 'Synthetic retake');
    INSERT INTO login_attempts (key, fails) VALUES ('s:DAMILANDCBT004:127.0.0.1', 1), ('s:DAMILANDCBT001:127.0.0.1', 2), ('a:staff@example.test:127.0.0.1', 1);`);
  return db;
}

const preserved = (db) => JSON.stringify({
  students: db.prepare('SELECT * FROM students WHERE id < 4 ORDER BY id').all(),
  attempts: db.prepare('SELECT * FROM attempts WHERE student_id < 4 ORDER BY id').all(),
  answers: db.prepare('SELECT * FROM answers WHERE attempt_id = 1').all(),
  scores: db.prepare('SELECT * FROM scores WHERE attempt_id = 1').all(),
  questions: db.prepare('SELECT * FROM questions ORDER BY id').all(),
  exams: db.prepare('SELECT * FROM exams ORDER BY id').all(),
  settings: db.prepare('SELECT * FROM settings ORDER BY key').all(),
  admins: db.prepare('SELECT * FROM admins ORDER BY id').all(),
});

test('removes the complete synthetic batch and its records while preserving other data', (t) => {
  const db = fixture(); t.after(() => db.close());
  const before = preserved(db);
  assert.equal(db.prepare(previewSql).get().testStudents, 100);
  assert.equal(db.prepare(previewSql).get().testAnswers, 20000);
  db.exec('BEGIN');
  try { db.exec(cleanupSql); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM students').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM answers').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scores').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attempt_archives').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 2);
  assert.equal(preserved(db), before);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'cleanup_loadtest_20261020_guard'").get().n, 0);
});

for (const [name, change] of [
  ['a student name has changed', "UPDATE students SET full_name = 'Real Student' WHERE id = 4"],
  ['a duplicate synthetic name replaces a missing name', 'UPDATE students SET full_name = (SELECT full_name FROM students WHERE id = 5) WHERE id = 4'],
  ['a target has taken another exam', "INSERT INTO attempts (student_id, exam_id, group_no, submitted_at) VALUES (4, 1, 2, datetime('now'))"],
  ['an exam is currently running', 'UPDATE attempts SET submitted_at = NULL WHERE id = 1'],
  ['the test exam is live', "UPDATE settings SET value = '3' WHERE key = 'current_exam_id'"],
]) {
  test('refuses cleanup when ' + name, (t) => {
    const db = fixture(); t.after(() => db.close());
    if (name === 'a target has taken another exam') db.exec('DROP TRIGGER attempts_ready');
    db.exec(change);
    const before = preserved(db);
    db.exec('BEGIN');
    assert.throws(() => db.exec(cleanupSql), /CHECK constraint failed/);
    db.exec('ROLLBACK');
    assert.equal(preserved(db), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM students').get().n, 103);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM answers').get().n, 20001);
  });
}
