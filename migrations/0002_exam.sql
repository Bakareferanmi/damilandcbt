-- Step 3: the exam. Adds the exam end time and allows only ONE sitting per student.
ALTER TABLE attempts ADD COLUMN ends_at INTEGER; -- unix seconds
CREATE UNIQUE INDEX idx_attempts_one_per_student ON attempts(student_id);
