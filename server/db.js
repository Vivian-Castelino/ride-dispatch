import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH || path.join(here, '..', 'data', 'rides.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rides (
  id          TEXT PRIMARY KEY,
  rider       TEXT NOT NULL,
  pickup      TEXT NOT NULL,
  dropoff     TEXT NOT NULL,
  status      TEXT NOT NULL,            -- REQUESTED | ASSIGNED | NO_DRIVER_FOUND
  driver_id   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- The queue. One row per ride waiting to be offered to drivers.
CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id    TEXT NOT NULL UNIQUE,
  state      TEXT NOT NULL,             -- queued | processing | done
  locked_by  TEXT,
  locked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, id);

-- Every offer made to a driver and what they said.
CREATE TABLE IF NOT EXISTS offers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id    TEXT NOT NULL,
  driver_id  TEXT NOT NULL,
  response   TEXT NOT NULL,             -- ACCEPTED | REJECTED
  created_at INTEGER NOT NULL,
  UNIQUE (ride_id, driver_id)           -- a driver is never offered the same ride twice
);

-- Append-only event log. Consumers keep their own read position.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id    TEXT NOT NULL,
  status     TEXT NOT NULL,
  driver_id  TEXT,
  created_at INTEGER NOT NULL
);

-- One row per consumer ("consumer group"): independent offsets = every consumer sees every event.
CREATE TABLE IF NOT EXISTS consumer_offsets (
  consumer      TEXT PRIMARY KEY,
  last_event_id INTEGER NOT NULL DEFAULT 0,
  processed     INTEGER NOT NULL DEFAULT 0
);
`;

export function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 10000;'); // several processes share this file
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a write transaction (takes the write lock up front, so no deadlocks between processes). */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const STATUS = Object.freeze({
  REQUESTED: 'REQUESTED',
  ASSIGNED: 'ASSIGNED',
  NO_DRIVER_FOUND: 'NO_DRIVER_FOUND',
});
