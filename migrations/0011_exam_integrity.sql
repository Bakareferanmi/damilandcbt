-- Apply before deploying the matching API. Existing papers with attempts are locked too.
ALTER TABLE exams ADD COLUMN locked_at TEXT;
UPDATE exams SET locked_at = COALESCE((SELECT MIN(started_at) FROM attempts WHERE exam_id = exams.id), datetime('now'))
 WHERE EXISTS (SELECT 1 FROM attempts WHERE exam_id = exams.id);
ALTER TABLE admins ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE students ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE answers ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scores ADD COLUMN total INTEGER NOT NULL DEFAULT 0;
UPDATE scores SET total = (SELECT COUNT(*) FROM questions q JOIN attempts a ON a.exam_id = q.exam_id
 WHERE a.id = scores.attempt_id AND q.subject_id = scores.subject_id);
-- Keep totals correct during the short migration-before-deploy compatibility window.
CREATE TRIGGER scores_fill_total AFTER INSERT ON scores WHEN NEW.total = 0 BEGIN
  UPDATE scores SET total = (SELECT COUNT(*) FROM questions q JOIN attempts a ON a.exam_id = q.exam_id
    WHERE a.id = NEW.attempt_id AND q.subject_id = NEW.subject_id)
   WHERE attempt_id = NEW.attempt_id AND subject_id = NEW.subject_id;
END;

-- Keep an exact record before a retake removes the active attempt. No passwords are archived.
CREATE TABLE attempt_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  exam_id INTEGER NOT NULL REFERENCES exams(id),
  original_attempt_id INTEGER NOT NULL UNIQUE,
  attempt_json TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  scores_json TEXT NOT NULL,
  authorised_by INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_attempt_archives_student ON attempt_archives(student_id, exam_id);
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The readiness check and paper lock run in the same statement as creating an attempt.
CREATE TRIGGER attempts_ready BEFORE INSERT ON attempts BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM exams e JOIN students s ON s.id = NEW.student_id
     WHERE e.id = NEW.exam_id AND e.session_id = s.session_id
       AND e.id = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'current_exam_id')
       AND s.session_id = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'current_session_id')
  ) THEN RAISE(ABORT, 'EXAM_CHANGED') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM subjects s
     WHERE (s.id = 'eng' OR s.id IN (SELECT subject_id FROM group_subjects WHERE group_no = NEW.group_no))
       AND (SELECT COUNT(*) FROM questions q WHERE q.exam_id = NEW.exam_id AND q.subject_id = s.id) <> 50
  ) THEN RAISE(ABORT, 'EXAM_NOT_READY') END;
END;
CREATE TRIGGER attempts_lock_paper AFTER INSERT ON attempts BEGIN
  UPDATE exams SET locked_at = COALESCE(locked_at, datetime('now')) WHERE id = NEW.exam_id;
END;
CREATE TRIGGER questions_locked_insert BEFORE INSERT ON questions
 WHEN EXISTS (SELECT 1 FROM exams WHERE id = NEW.exam_id AND locked_at IS NOT NULL)
 BEGIN SELECT RAISE(ABORT, 'PAPER_LOCKED'); END;
CREATE TRIGGER questions_locked_update BEFORE UPDATE ON questions
 WHEN EXISTS (SELECT 1 FROM exams WHERE id IN (OLD.exam_id, NEW.exam_id) AND locked_at IS NOT NULL)
 BEGIN SELECT RAISE(ABORT, 'PAPER_LOCKED'); END;
CREATE TRIGGER questions_locked_delete BEFORE DELETE ON questions
 WHEN EXISTS (SELECT 1 FROM exams WHERE id = OLD.exam_id AND locked_at IS NOT NULL)
 BEGIN SELECT RAISE(ABORT, 'PAPER_LOCKED'); END;
CREATE TRIGGER exams_locked_details BEFORE UPDATE OF name, minutes ON exams
 WHEN OLD.locked_at IS NOT NULL AND (NEW.name <> OLD.name OR NEW.minutes <> OLD.minutes)
 BEGIN SELECT RAISE(ABORT, 'PAPER_LOCKED'); END;

-- Refuse an unconfirmed switch even if a student started after the API counted writers.
-- Confirmed transitions close attempts and change settings in one transaction.
CREATE TRIGGER settings_running_exam BEFORE UPDATE ON settings
 WHEN OLD.key IN ('current_exam_id', 'current_session_id') AND NEW.value <> OLD.value
  AND EXISTS (SELECT 1 FROM attempts WHERE exam_id = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'current_exam_id') AND submitted_at IS NULL)
 BEGIN SELECT RAISE(ABORT, 'EXAM_STILL_WRITING'); END;
