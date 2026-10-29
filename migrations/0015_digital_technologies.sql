-- Independent SS1 / SS2 papers. Additive only: existing SS3 records and triggers stay intact.
CREATE TABLE digital_exams (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 session_id INTEGER NOT NULL REFERENCES sessions(id),
 cohort TEXT NOT NULL CHECK(cohort IN ('SS1','SS2')),
 name TEXT NOT NULL,
 minutes INTEGER NOT NULL DEFAULT 30 CHECK(minutes BETWEEN 10 AND 180),
 state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','open','closed')),
 locked_at INTEGER,
 results_released INTEGER NOT NULL DEFAULT 0 CHECK(results_released IN (0,1)),
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 UNIQUE(session_id,cohort,name)
);
CREATE UNIQUE INDEX digital_one_open ON digital_exams(session_id,cohort) WHERE state='open';
CREATE INDEX digital_exam_space ON digital_exams(session_id,cohort,id);
CREATE TABLE digital_students (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 session_id INTEGER NOT NULL REFERENCES sessions(id),
 cohort TEXT NOT NULL CHECK(cohort IN ('SS1','SS2')),
 seq INTEGER NOT NULL,
 code TEXT NOT NULL,
 full_name TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 password_enc TEXT NOT NULL,
 auth_version INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 UNIQUE(session_id,cohort,seq),
 UNIQUE(session_id,code)
);
CREATE INDEX digital_students_space ON digital_students(session_id,cohort,full_name,id);
CREATE TABLE digital_questions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 exam_id INTEGER NOT NULL REFERENCES digital_exams(id),
 body TEXT NOT NULL,
 option_a TEXT NOT NULL, option_b TEXT NOT NULL, option_c TEXT NOT NULL, option_d TEXT NOT NULL,
 correct TEXT NOT NULL CHECK(correct IN ('A','B','C','D'))
);
CREATE INDEX digital_questions_exam ON digital_questions(exam_id,id);
CREATE TABLE digital_attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 student_id INTEGER NOT NULL REFERENCES digital_students(id),
 exam_id INTEGER NOT NULL REFERENCES digital_exams(id),
 started_at INTEGER NOT NULL DEFAULT (unixepoch()),
 ends_at INTEGER NOT NULL,
 submitted_at INTEGER,
 score INTEGER CHECK(score BETWEEN 0 AND 30),
 answered INTEGER NOT NULL DEFAULT 0 CHECK(answered BETWEEN 0 AND 30),
 focus_count INTEGER NOT NULL DEFAULT 0,
 UNIQUE(student_id,exam_id)
);
CREATE INDEX digital_attempts_deadline ON digital_attempts(exam_id,submitted_at,ends_at);
CREATE TABLE digital_attempt_questions (
 attempt_id INTEGER NOT NULL REFERENCES digital_attempts(id),
 question_id INTEGER NOT NULL REFERENCES digital_questions(id),
 position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 30),
 PRIMARY KEY(attempt_id,question_id),
 UNIQUE(attempt_id,position)
);
CREATE TABLE digital_answers (
 attempt_id INTEGER NOT NULL,
 question_id INTEGER NOT NULL,
 chosen TEXT NOT NULL CHECK(chosen IN ('A','B','C','D')),
 revision INTEGER NOT NULL CHECK(revision>0),
 PRIMARY KEY(attempt_id,question_id),
 FOREIGN KEY(attempt_id,question_id) REFERENCES digital_attempt_questions(attempt_id,question_id)
);
CREATE TABLE digital_focus_events (
 attempt_id INTEGER NOT NULL REFERENCES digital_attempts(id),
 event_id TEXT NOT NULL,
 occurred_at INTEGER NOT NULL,
 PRIMARY KEY(attempt_id,event_id)
);
CREATE TRIGGER digital_ready BEFORE INSERT ON digital_attempts BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM digital_exams e JOIN digital_students s ON s.id=NEW.student_id
  WHERE e.id=NEW.exam_id AND e.session_id=s.session_id AND e.cohort=s.cohort AND e.state='open'
   AND s.session_id=(SELECT CAST(value AS INTEGER) FROM settings WHERE key='current_session_id')
   AND NEW.ends_at=NEW.started_at+e.minutes*60
 ) THEN RAISE(ABORT,'DIGITAL_EXAM_CHANGED') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM digital_questions WHERE exam_id=NEW.exam_id) NOT BETWEEN 30 AND 70
  THEN RAISE(ABORT,'DIGITAL_BANK_NOT_READY') END;
END;
CREATE TRIGGER digital_allocate AFTER INSERT ON digital_attempts BEGIN
 INSERT INTO digital_attempt_questions(attempt_id,question_id,position)
 SELECT NEW.id,id,position FROM (
  SELECT id,ROW_NUMBER() OVER(ORDER BY random()) position FROM digital_questions WHERE exam_id=NEW.exam_id
 ) WHERE position<=30;
 UPDATE digital_exams SET locked_at=COALESCE(locked_at,unixepoch()) WHERE id=NEW.exam_id;
END;
CREATE TRIGGER digital_bank_capacity BEFORE INSERT ON digital_questions
 WHEN (SELECT COUNT(*) FROM digital_questions WHERE exam_id=NEW.exam_id)>=70
 BEGIN SELECT RAISE(ABORT,'DIGITAL_BANK_FULL'); END;
CREATE TRIGGER digital_question_insert BEFORE INSERT ON digital_questions
 WHEN EXISTS(SELECT 1 FROM digital_exams WHERE id=NEW.exam_id AND locked_at IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'DIGITAL_PAPER_LOCKED'); END;
CREATE TRIGGER digital_question_update BEFORE UPDATE ON digital_questions
 WHEN EXISTS(SELECT 1 FROM digital_exams WHERE id IN (OLD.exam_id,NEW.exam_id) AND locked_at IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'DIGITAL_PAPER_LOCKED'); END;
CREATE TRIGGER digital_question_delete BEFORE DELETE ON digital_questions
 WHEN EXISTS(SELECT 1 FROM digital_exams WHERE id=OLD.exam_id AND locked_at IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'DIGITAL_PAPER_LOCKED'); END;
CREATE TRIGGER digital_exam_details BEFORE UPDATE OF name,minutes,cohort,session_id ON digital_exams
 WHEN OLD.locked_at IS NOT NULL AND (NEW.name<>OLD.name OR NEW.minutes<>OLD.minutes OR NEW.cohort<>OLD.cohort OR NEW.session_id<>OLD.session_id)
 BEGIN SELECT RAISE(ABORT,'DIGITAL_PAPER_LOCKED'); END;
CREATE TRIGGER digital_open BEFORE UPDATE OF state ON digital_exams WHEN NEW.state='open' AND OLD.state<>'open' BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM digital_questions WHERE exam_id=NEW.id) NOT BETWEEN 30 AND 70
  THEN RAISE(ABORT,'DIGITAL_BANK_NOT_READY') END;
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM digital_exams e WHERE e.session_id=NEW.session_id AND e.cohort=NEW.cohort AND e.id<>NEW.id
   AND (e.state='open' OR EXISTS(SELECT 1 FROM digital_attempts a WHERE a.exam_id=e.id AND a.submitted_at IS NULL))
 ) THEN RAISE(ABORT,'DIGITAL_SPACE_BUSY') END;
END;
CREATE TRIGGER digital_answer_insert BEFORE INSERT ON digital_answers
 WHEN EXISTS(SELECT 1 FROM digital_attempts WHERE id=NEW.attempt_id AND (submitted_at IS NOT NULL OR unixepoch()>ends_at+10))
 BEGIN SELECT RAISE(ABORT,'DIGITAL_FINISHED'); END;
CREATE TRIGGER digital_answer_update BEFORE UPDATE ON digital_answers
 WHEN EXISTS(SELECT 1 FROM digital_attempts WHERE id=NEW.attempt_id AND (submitted_at IS NOT NULL OR unixepoch()>ends_at+10))
 BEGIN SELECT RAISE(ABORT,'DIGITAL_FINISHED'); END;
CREATE TRIGGER digital_answered AFTER INSERT ON digital_answers BEGIN
 UPDATE digital_attempts SET answered=answered+1 WHERE id=NEW.attempt_id;
END;
CREATE TRIGGER digital_focus_count AFTER INSERT ON digital_focus_events BEGIN
 UPDATE digital_attempts SET focus_count=focus_count+1 WHERE id=NEW.attempt_id;
END;
INSERT INTO digital_exams(session_id,cohort,name)
 SELECT CAST(value AS INTEGER),'SS1','Digital Technologies' FROM settings WHERE key='current_session_id';
INSERT INTO digital_exams(session_id,cohort,name)
 SELECT CAST(value AS INTEGER),'SS2','Digital Technologies' FROM settings WHERE key='current_session_id';
-- Do not strand a Digital Technologies sitting by changing the academic session.
CREATE TRIGGER digital_session_running BEFORE UPDATE OF value ON settings
 WHEN OLD.key='current_session_id' AND NEW.value<>OLD.value
  AND EXISTS(SELECT 1 FROM digital_attempts WHERE submitted_at IS NULL)
 BEGIN SELECT RAISE(ABORT,'DIGITAL_SESSION_BUSY'); END;
