CREATE TABLE IF NOT EXISTS review_cutover_controls (
  repo_full_name TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT 'shadow',
  freeze_verified_at TEXT,
  freeze_verified_by TEXT,
  rollback_dry_run_at TEXT,
  rollback_dry_run_by TEXT,
  last_live_at TEXT,
  last_rollback_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
