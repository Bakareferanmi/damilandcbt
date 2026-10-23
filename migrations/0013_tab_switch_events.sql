-- Apply before deploying the tab-switch API.
CREATE TABLE exam_focus_events (
 attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL,
 occurred_at INTEGER NOT NULL,
 received_at TEXT NOT NULL DEFAULT (datetime('now')),
 PRIMARY KEY (attempt_id, event_id)
);
