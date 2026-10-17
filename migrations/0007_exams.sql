-- Exams inside a session. A session (e.g. 2026/2027) can hold several exams (First Term, Mock, ...).
-- Students belong to the session; questions, attempts, answers, scores and the exam length belong to an exam.
-- Only ONE exam is "live" at a time (settings.current_exam_id): that is the one students can sit.
-- The attempts table is rebuilt (with answers and scores, children dropped first) so a student can sit
-- one attempt PER EXAM instead of one in total.

CREATE TABLE exams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  name       TEXT NOT NULL,
  minutes    INTEGER NOT NULL DEFAULT 120,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, name)
);

-- Every existing session gets one exam holding what it already has. It keeps the old exam length.
INSERT INTO exams (session_id, name, minutes)
  SELECT id, 'Exam 1', COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'exam_minutes'), 120) FROM sessions;

INSERT INTO settings (key, value)
  SELECT 'current_exam_id', CAST(e.id AS TEXT) FROM exams e
   WHERE e.session_id = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'current_session_id');

ALTER TABLE questions ADD COLUMN exam_id INTEGER;
UPDATE questions SET exam_id = (SELECT e.id FROM exams e WHERE e.session_id = questions.session_id);
CREATE INDEX idx_questions_exam ON questions(exam_id, subject_id);

CREATE TABLE attempts_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id   INTEGER NOT NULL REFERENCES students(id),
  exam_id      INTEGER NOT NULL REFERENCES exams(id),
  group_no     INTEGER NOT NULL CHECK (group_no BETWEEN 1 AND 4),
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  ends_at      INTEGER,
  released     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (student_id, exam_id)
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

INSERT INTO attempts_new (id, student_id, exam_id, group_no, started_at, submitted_at, ends_at, released)
  SELECT a.id, a.student_id, (SELECT e.id FROM exams e JOIN students s ON s.session_id = e.session_id WHERE s.id = a.student_id),
         a.group_no, a.started_at, a.submitted_at, a.ends_at, a.released
    FROM attempts a;
INSERT INTO answers_new (attempt_id, question_id, chosen) SELECT attempt_id, question_id, chosen FROM answers;
INSERT INTO scores_new (attempt_id, subject_id, score) SELECT attempt_id, subject_id, score FROM scores;

DROP TABLE scores;
DROP TABLE answers;
DROP TABLE attempts;

ALTER TABLE attempts_new RENAME TO attempts;
ALTER TABLE answers_new RENAME TO answers;
ALTER TABLE scores_new RENAME TO scores;
