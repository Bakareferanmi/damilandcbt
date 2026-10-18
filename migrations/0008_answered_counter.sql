-- Saves database reads. The monitor used to recount every student's answers on every refresh.
-- Now each attempt keeps its own running "answered" number (kept up to date by the app when an answer is saved).
-- Also adds an index so "open attempts of this exam" is not a full scan.

ALTER TABLE attempts ADD COLUMN answered INTEGER NOT NULL DEFAULT 0;
UPDATE attempts SET answered = (SELECT COUNT(*) FROM answers w WHERE w.attempt_id = attempts.id);
CREATE INDEX idx_attempts_exam ON attempts(exam_id, submitted_at);
