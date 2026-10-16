-- Students only see their scores after an admin releases them.
ALTER TABLE attempts ADD COLUMN released INTEGER NOT NULL DEFAULT 0;
