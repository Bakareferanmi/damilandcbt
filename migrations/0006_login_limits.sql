-- Remembers wrong-password tries so repeated guessing gets locked for a few minutes.
CREATE TABLE login_attempts (
  key          TEXT PRIMARY KEY, -- 's:<student code>' or 'a:<admin email>'
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0, -- unix seconds
  last_at      INTEGER NOT NULL DEFAULT 0
);
