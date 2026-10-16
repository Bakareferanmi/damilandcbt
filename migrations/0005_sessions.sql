-- Academic sessions. Each session (e.g. 2026/2027) has its own students, question bank, attempts and results.
-- Student numbers (DAMILANDCBT001...) restart in every session, so the students table is rebuilt.
-- Tables that point at students (attempts, answers, scores) are rebuilt with it, children dropped first,
-- so no foreign-key problem can occur.

CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sessions (name) VALUES ('2026/2027'); -- rename it on the Settings page if needed
INSERT INTO settings (key, value) VALUES ('current_session_id', '1');

-- Questions belong to a session.
ALTER TABLE questions ADD COLUMN session_id INTEGER;
UPDATE questions SET session_id = 1;
CREATE INDEX idx_questions_session ON questions(session_id, subject_id);

-- New versions of the four tables.
CREATE TABLE students_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  seq           INTEGER NOT NULL,
  code          TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  class_name    TEXT NOT NULL CHECK (class_name IN ('SS3 Art', 'SS3 Commercial', 'SS3 Science')),
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, code),
  UNIQUE (session_id, seq)
);
CREATE TABLE attempts_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id   INTEGER NOT NULL UNIQUE REFERENCES students_new(id),
  group_no     INTEGER NOT NULL CHECK (group_no BETWEEN 1 AND 4),
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  ends_at      INTEGER,
  released     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE answers_new (
  attempt_id  INTEGER NOT NULL REFERENCES attempts_new(id),
  question_id INTEGER NOT NULL REFERENCES questions(id),
  chosen      TEXT CHECK (chosen IN ('A', 'B', 'C', 'D')),
  PRIMARY KEY (attempt_id, question_id)
);
CREATE TABLE scores_new (
  attempt_id INTEGER NOT NULL REFERENCES attempts_new(id),
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  score      INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, subject_id)
);

-- Copy everything across (all existing data belongs to the first session).
INSERT INTO students_new (id, session_id, seq, code, full_name, class_name, password_hash, created_at)
  SELECT id, 1, id, code, full_name, class_name, password_hash, created_at FROM students;
INSERT INTO attempts_new (id, student_id, group_no, started_at, submitted_at, ends_at, released)
  SELECT id, student_id, group_no, started_at, submitted_at, ends_at, released FROM attempts;
INSERT INTO answers_new (attempt_id, question_id, chosen) SELECT attempt_id, question_id, chosen FROM answers;
INSERT INTO scores_new (attempt_id, subject_id, score) SELECT attempt_id, subject_id, score FROM scores;

-- Drop the old ones, children first.
DROP TABLE scores;
DROP TABLE answers;
DROP TABLE attempts;
DROP TABLE students;

ALTER TABLE students_new RENAME TO students;
ALTER TABLE attempts_new RENAME TO attempts;
ALTER TABLE answers_new RENAME TO answers;
ALTER TABLE scores_new RENAME TO scores;
