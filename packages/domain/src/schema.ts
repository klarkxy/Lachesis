export const SCHEMA_VERSION = 2

export const MIGRATION_V2 = `
ALTER TABLE issues ADD COLUMN owned_paths TEXT NOT NULL DEFAULT '[]';
ALTER TABLE issues ADD COLUMN read_only_paths TEXT NOT NULL DEFAULT '[]';

CREATE TABLE scheduler_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  global_max_active INTEGER NOT NULL,
  profile_limits TEXT NOT NULL,
  provider_limits TEXT NOT NULL
) STRICT;
INSERT INTO scheduler_settings VALUES (1, 1, 4, '{}', '{}');

CREATE TABLE project_dispatch (
  project_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  paused INTEGER NOT NULL,
  environment_code TEXT,
  environment_diagnostic TEXT,
  environment_created_at TEXT
) STRICT;
INSERT INTO project_dispatch (project_id, version, paused)
  SELECT id, 1, 0 FROM projects;

CREATE TABLE scheduler_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  project_id TEXT,
  profile_id TEXT
) STRICT;
INSERT INTO scheduler_cursor (id) VALUES (1);

CREATE TABLE run_checkpoints (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  base_ref TEXT,
  manifest_sha256 TEXT NOT NULL,
  files TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
`

export const MIGRATION_V1 = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  root_path TEXT NOT NULL,
  target_branch TEXT,
  verification_command TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_preset_id TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  model_id TEXT NOT NULL,
  reasoning_effort TEXT,
  revision INTEGER NOT NULL,
  disabled INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE profile_revisions (
  profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  provider_ref TEXT NOT NULL,
  model_id TEXT NOT NULL,
  reasoning_effort TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, revision)
) STRICT;

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  dispatch_mode TEXT NOT NULL,
  dispatch_profile_id TEXT,
  requester_ref TEXT NOT NULL,
  client_request_id TEXT,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  current_run_id TEXT,
  accepted_delivery_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX issues_client_request
  ON issues(project_id, requester_ref, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX issues_project_status_created
  ON issues(project_id, status, created_at, id);

CREATE TABLE issue_dependencies (
  issue_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (issue_id, depends_on)
) STRICT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  provider_ref TEXT NOT NULL,
  model_id TEXT NOT NULL,
  reasoning_effort TEXT,
  session_id TEXT,
  workspace_path TEXT NOT NULL,
  base_ref TEXT,
  generation INTEGER NOT NULL,
  claimed_by TEXT,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (issue_id, attempt)
) STRICT;

CREATE UNIQUE INDEX runs_one_live
  ON runs(issue_id)
  WHERE status IN ('starting', 'running', 'needs_input', 'cancelling');

CREATE INDEX runs_profile ON runs(profile_id, profile_revision);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  summary TEXT NOT NULL,
  final_response TEXT,
  files TEXT NOT NULL,
  evidence TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE evaluations (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  delivery_id TEXT,
  run_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL,
  score INTEGER NOT NULL,
  comment TEXT NOT NULL,
  revision INTEGER NOT NULL,
  active INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (score >= 1 AND score <= 5)
) STRICT;

CREATE UNIQUE INDEX evaluations_one_active
  ON evaluations(issue_id)
  WHERE active = 1;

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expected_target TEXT,
  result_target TEXT,
  diagnostic TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE application_evidence (
  application_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  PRIMARY KEY (application_id, ordinal)
) STRICT;

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  delivered INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  items TEXT NOT NULL,
  answers TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
) STRICT;

CREATE TABLE run_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  text TEXT NOT NULL,
  delivered INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  issue_id TEXT,
  run_id TEXT,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX events_project_sequence ON events(project_id, sequence);

CREATE TABLE idempotency (
  actor_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, project_id, operation, key)
) STRICT;
`
