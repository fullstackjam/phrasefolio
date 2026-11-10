CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  expression TEXT NOT NULL,
  expression_key TEXT NOT NULL UNIQUE,
  original_sentence TEXT NOT NULL DEFAULT '',
  meaning_zh TEXT NOT NULL DEFAULT '',
  usage_note TEXT NOT NULL DEFAULT '',
  example TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  added_date TEXT NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 1 CHECK (interval_days >= 0),
  next_review TEXT NOT NULL DEFAULT '',
  ease REAL NOT NULL DEFAULT 2.5 CHECK (ease > 0),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  scene_zh TEXT NOT NULL DEFAULT '',
  known INTEGER NOT NULL DEFAULT 0 CHECK (known IN (0, 1)),
  known_at TEXT
);
