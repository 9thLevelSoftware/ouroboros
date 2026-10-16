-- Migration 1. Controller SQL lives exclusively in src/store.
CREATE TABLE runs (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation >= 0), record TEXT NOT NULL, limits TEXT NOT NULL);
CREATE TABLE repo_ownership (repo_id TEXT PRIMARY KEY, run_id TEXT UNIQUE REFERENCES runs(id), generation INTEGER NOT NULL, nonce TEXT, CHECK ((run_id IS NULL) = (nonce IS NULL)));
CREATE TABLE actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('INTENDED','DISPATCHED','OBSERVED','OUTCOME_UNKNOWN')), record TEXT NOT NULL);
CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), action_id TEXT REFERENCES actions(id), sha256 TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE checks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), record TEXT NOT NULL);
CREATE TABLE qualifications (id TEXT PRIMARY KEY, run_id TEXT REFERENCES runs(id), record TEXT NOT NULL);
CREATE TABLE proposals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), record TEXT NOT NULL);
CREATE TABLE knowledge_versions (id TEXT PRIMARY KEY, proposal_id TEXT REFERENCES proposals(id), record TEXT NOT NULL);
CREATE TABLE control_requests (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), generation INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)), record TEXT NOT NULL);
CREATE INDEX actions_by_run ON actions(run_id, state);
CREATE INDEX artifacts_by_run ON artifacts(run_id);
CREATE INDEX requests_by_run ON control_requests(run_id, consumed);
