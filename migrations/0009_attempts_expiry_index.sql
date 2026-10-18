-- Speeds up "which open attempts of this exam have run out of time?". The Monitor asks this on every refresh.
-- The old index held (exam_id, submitted_at); this one also holds ends_at, so when nobody has expired
-- the check reads nothing instead of every open attempt. Safe to apply before or after deploying the code.

DROP INDEX IF EXISTS idx_attempts_exam;
CREATE INDEX idx_attempts_exam ON attempts(exam_id, submitted_at, ends_at);
