-- Damiland CBT database, version 1.
-- Applied with: npm run db:migrate:local  (your computer)  or  npm run db:migrate:remote  (Cloudflare)

CREATE TABLE admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Student number = id. Code = DAMILANDCBT + id padded to 3 digits (001, 002, ...), so it always counts upward.
CREATE TABLE students (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  class_name    TEXT NOT NULL CHECK (class_name IN ('SS3 Art', 'SS3 Commercial', 'SS3 Science')),
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE subjects (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- Which subjects belong to which group. Use of English is added to every group by the app.
CREATE TABLE group_subjects (
  group_no   INTEGER NOT NULL CHECK (group_no BETWEEN 1 AND 4),
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  PRIMARY KEY (group_no, subject_id)
);

CREATE TABLE questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  body       TEXT NOT NULL,
  option_a   TEXT NOT NULL,
  option_b   TEXT NOT NULL,
  option_c   TEXT NOT NULL,
  option_d   TEXT NOT NULL,
  correct    TEXT NOT NULL CHECK (correct IN ('A', 'B', 'C', 'D')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_questions_subject ON questions(subject_id);

-- One row each time a student sits the exam.
CREATE TABLE attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id   INTEGER NOT NULL REFERENCES students(id),
  group_no     INTEGER NOT NULL CHECK (group_no BETWEEN 1 AND 4),
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT
);
CREATE INDEX idx_attempts_student ON attempts(student_id);

CREATE TABLE answers (
  attempt_id  INTEGER NOT NULL REFERENCES attempts(id),
  question_id INTEGER NOT NULL REFERENCES questions(id),
  chosen      TEXT CHECK (chosen IN ('A', 'B', 'C', 'D')),
  PRIMARY KEY (attempt_id, question_id)
);

-- Score per subject for a finished attempt (out of 50). Feeds the admin charts.
CREATE TABLE scores (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  score      INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, subject_id)
);

INSERT INTO subjects (id, name) VALUES
  ('eng', 'Use of English'), ('gov', 'Government'), ('lit', 'Literature'), ('crs', 'CRS'),
  ('math', 'Mathematics'), ('phy', 'Physics'), ('chem', 'Chemistry'), ('bio', 'Biology'),
  ('eco', 'Economics'), ('acc', 'Account');

INSERT INTO group_subjects (group_no, subject_id) VALUES
  (1, 'gov'), (1, 'lit'), (1, 'crs'),
  (2, 'math'), (2, 'phy'), (2, 'chem'),
  (3, 'bio'), (3, 'phy'), (3, 'chem'),
  (4, 'math'), (4, 'eco'), (4, 'acc');
