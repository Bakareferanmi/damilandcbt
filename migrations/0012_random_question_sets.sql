-- Apply with the matching API before allowing students to start.
CREATE TABLE attempt_questions (
  attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  PRIMARY KEY (attempt_id, question_id)
);
-- Preserve the full original paper for every existing attempt.
INSERT INTO attempt_questions (attempt_id, question_id)
 SELECT a.id, q.id FROM attempts a JOIN questions q ON q.exam_id = a.exam_id
 WHERE q.subject_id = 'eng' OR q.subject_id IN
   (SELECT subject_id FROM group_subjects WHERE group_no = a.group_no);
DROP TRIGGER attempts_ready;
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
       AND (SELECT COUNT(*) FROM questions q WHERE q.exam_id = NEW.exam_id AND q.subject_id = s.id) NOT BETWEEN 50 AND 80
  ) THEN RAISE(ABORT, 'EXAM_NOT_READY') END;
END;

-- Selection and attempt creation commit together, including simultaneous starts.
CREATE TRIGGER attempts_allocate_questions AFTER INSERT ON attempts BEGIN
 INSERT INTO attempt_questions (attempt_id, question_id)
 SELECT NEW.id, id FROM (
   SELECT q.id, ROW_NUMBER() OVER (PARTITION BY q.subject_id ORDER BY random()) AS position
   FROM questions q WHERE q.exam_id = NEW.exam_id AND
    (q.subject_id = 'eng' OR q.subject_id IN
      (SELECT subject_id FROM group_subjects WHERE group_no = NEW.group_no))
 ) WHERE position <= 50;
END;
DROP TRIGGER scores_fill_total;
CREATE TRIGGER scores_fill_total AFTER INSERT ON scores WHEN NEW.total = 0 BEGIN
 UPDATE scores SET total = (SELECT COUNT(*) FROM attempt_questions aq JOIN questions q ON q.id = aq.question_id
  WHERE aq.attempt_id = NEW.attempt_id AND q.subject_id = NEW.subject_id)
 WHERE attempt_id = NEW.attempt_id AND subject_id = NEW.subject_id;
END;
