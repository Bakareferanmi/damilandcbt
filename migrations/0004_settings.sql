-- Settings the admin can change on the site (key/value). Exam length starts at 120 minutes.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('exam_minutes', '120');
