-- Increase bank caps without changing allocations or existing attempts.
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
       AND (SELECT COUNT(*) FROM questions q WHERE q.exam_id = NEW.exam_id AND q.subject_id = s.id) NOT BETWEEN 50 AND 100
  ) THEN RAISE(ABORT, 'EXAM_NOT_READY') END;
END;

DROP TRIGGER digital_ready;
CREATE TRIGGER digital_ready BEFORE INSERT ON digital_attempts BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM digital_exams e JOIN digital_students s ON s.id=NEW.student_id
  WHERE e.id=NEW.exam_id AND e.session_id=s.session_id AND e.cohort=s.cohort AND e.state='open'
   AND s.session_id=(SELECT CAST(value AS INTEGER) FROM settings WHERE key='current_session_id')
   AND NEW.ends_at=NEW.started_at+e.minutes*60
 ) THEN RAISE(ABORT,'DIGITAL_EXAM_CHANGED') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM digital_questions WHERE exam_id=NEW.exam_id) NOT BETWEEN 30 AND 100
  THEN RAISE(ABORT,'DIGITAL_BANK_NOT_READY') END;
END;

DROP TRIGGER digital_bank_capacity;
CREATE TRIGGER digital_bank_capacity BEFORE INSERT ON digital_questions
 WHEN (SELECT COUNT(*) FROM digital_questions WHERE exam_id=NEW.exam_id)>=100
 BEGIN SELECT RAISE(ABORT,'DIGITAL_BANK_FULL'); END;

DROP TRIGGER digital_open;
CREATE TRIGGER digital_open BEFORE UPDATE OF state ON digital_exams WHEN NEW.state='open' AND OLD.state<>'open' BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM digital_questions WHERE exam_id=NEW.id) NOT BETWEEN 30 AND 100
  THEN RAISE(ABORT,'DIGITAL_BANK_NOT_READY') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM digital_exams e WHERE e.session_id=NEW.session_id AND e.cohort=NEW.cohort AND e.id<>NEW.id
   AND (e.state='open' OR EXISTS(SELECT 1 FROM digital_attempts a WHERE a.exam_id=e.id AND a.submitted_at IS NULL))
 ) THEN RAISE(ABORT,'DIGITAL_SPACE_BUSY') END;
END;

INSERT INTO settings (key, value) VALUES ('expanded_question_banks', '100');
