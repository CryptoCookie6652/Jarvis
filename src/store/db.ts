import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id            TEXT PRIMARY KEY,
    task          TEXT,
    project       TEXT,
    prompt        TEXT,
    cwd           TEXT,
    status        TEXT NOT NULL,
    session_id    TEXT,
    model         TEXT,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    duration_ms   INTEGER,
    num_turns     INTEGER,
    cost_usd      REAL,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    result_text   TEXT,
    error         TEXT
  );
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  TEXT NOT NULL,
    ts      TEXT NOT NULL,
    type    TEXT,
    subtype TEXT,
    payload TEXT
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);');

const insertRunStmt = db.prepare(
  `INSERT INTO runs (id, task, project, prompt, cwd, status, started_at)
   VALUES (?, ?, ?, ?, ?, 'starting', ?)`,
);
const runStartedStmt = db.prepare(
  `UPDATE runs SET status = 'running', session_id = ?, model = ? WHERE id = ?`,
);
const runFinishedStmt = db.prepare(
  `UPDATE runs SET status = ?, ended_at = ?, duration_ms = ?, num_turns = ?,
   cost_usd = ?, input_tokens = ?, output_tokens = ?, result_text = ?, error = ?
   WHERE id = ?`,
);
const insertEventStmt = db.prepare(
  `INSERT INTO events (run_id, ts, type, subtype, payload) VALUES (?, ?, ?, ?, ?)`,
);
const getRunStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);

export function createRun(row: {
  id: string;
  task: string | null;
  project: string | null;
  prompt: string;
  cwd: string;
}) {
  insertRunStmt.run(row.id, row.task, row.project, row.prompt, row.cwd, new Date().toISOString());
}

export function runStarted(id: string, sessionId: string | null, model: string | null) {
  runStartedStmt.run(sessionId, model, id);
}

export function runFinished(
  id: string,
  fields: {
    status: string;
    durationMs: number | null;
    numTurns: number | null;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    resultText: string | null;
    error: string | null;
  },
) {
  runFinishedStmt.run(
    fields.status,
    new Date().toISOString(),
    fields.durationMs,
    fields.numTurns,
    fields.costUsd,
    fields.inputTokens,
    fields.outputTokens,
    fields.resultText,
    fields.error,
    id,
  );
}

export function insertEvent(runId: string, type: string, subtype: string | null, payload: string) {
  insertEventStmt.run(runId, new Date().toISOString(), type, subtype, payload);
}

export function getRun(id: string) {
  return getRunStmt.get(id);
}
