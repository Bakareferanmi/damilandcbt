-- Apply before deploying the matching monitor API. Preserves attempts and answers.
ALTER TABLE attempts ADD COLUMN assigned_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN focus_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN last_focus_at INTEGER;
-- One-time backfill; the monitor no longer scans these child rows on every poll.
UPDATE attempts SET
 assigned_total = (SELECT COUNT(*) FROM attempt_questions WHERE attempt_id = attempts.id),
 focus_count = (SELECT COUNT(*) FROM exam_focus_events WHERE attempt_id = attempts.id),
 last_focus_at = (SELECT MAX(occurred_at) FROM exam_focus_events WHERE attempt_id = attempts.id);
DROP TRIGGER attempts_allocate_questions;
CREATE TRIGGER attempts_allocate_questions AFTER INSERT ON attempts BEGIN
 INSERT INTO attempt_questions (attempt_id, question_id)
 SELECT NEW.id, id FROM (
   SELECT q.id, ROW_NUMBER() OVER (PARTITION BY q.subject_id ORDER BY random()) AS position
   FROM questions q WHERE q.exam_id = NEW.exam_id AND
    (q.subject_id = 'eng' OR q.subject_id IN
      (SELECT subject_id FROM group_subjects WHERE group_no = NEW.group_no))
 ) WHERE position <= 50;
 UPDATE attempts SET assigned_total = (SELECT COUNT(*) FROM attempt_questions WHERE attempt_id = NEW.id) WHERE id = NEW.id;
END;

-- INSERT OR IGNORE retries do not fire this trigger when the event already exists.
CREATE TRIGGER focus_event_summary AFTER INSERT ON exam_focus_events BEGIN
 UPDATE attempts SET focus_count = focus_count + 1,
 last_focus_at = MAX(COALESCE(last_focus_at, NEW.occurred_at), NEW.occurred_at)
 WHERE id = NEW.attempt_id;
END;
-- Filter roster rows directly by session and emit them in roster order.
CREATE INDEX IF NOT EXISTS idx_students_session_seq ON students(session_id, seq);
