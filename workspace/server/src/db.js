import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(__dirname, '..', 'data'), { recursive: true });

const db = new Database(join(__dirname, '..', 'data', 'coldchain.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  zone         TEXT NOT NULL,
  kind         TEXT NOT NULL,            -- 冷冻库 / 冷藏库 / 深冷库 / 恒温库 / 速冻库
  min_temp     REAL NOT NULL,
  max_temp     REAL NOT NULL,
  target_temp  REAL NOT NULL,
  volume       INTEGER NOT NULL,         -- 库容 m³
  sensor_code  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'online',  -- online / offline
  current_temp REAL,
  last_report_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS readings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  temp       REAL NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_readings_room_time ON readings(room_id, recorded_at);

CREATE TABLE IF NOT EXISTS alarms (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id      INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,            -- high_temp / low_temp / sensor_offline
  level        INTEGER NOT NULL DEFAULT 1, -- 1 一般 2 重要 3 紧急(升级后)
  value        REAL,                      -- 触发时温度(离线告警为空)
  threshold    REAL,
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active', -- active / acked / recovered
  escalated_at INTEGER,
  acked_by     TEXT,
  acked_at     INTEGER,
  recovered_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alarms_room_status ON alarms(room_id, status);
CREATE INDEX IF NOT EXISTS idx_alarms_status ON alarms(status, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  alarm_id    INTEGER NOT NULL REFERENCES alarms(id) ON DELETE CASCADE,
  room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 1,  -- 与告警等级联动
  status      TEXT NOT NULL DEFAULT 'pending', -- pending / accepted / processing / done / confirmed
  assignee    TEXT,
  result_note TEXT,
  accepted_at INTEGER,
  started_at  INTEGER,
  done_at     INTEGER,
  confirmed_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority);
`);

export default db;

// ---------- 通用查询辅助 ----------
export const now = () => Date.now();

export function getRoom(id) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
}

export function listRooms() {
  return db.prepare('SELECT * FROM rooms ORDER BY id').all();
}

export function activeAlarms() {
  return db
    .prepare(
      `SELECT a.*, r.code AS room_code, r.name AS room_name, r.kind AS room_kind
       FROM alarms a JOIN rooms r ON r.id = a.room_id
       WHERE a.status != 'recovered' ORDER BY a.created_at DESC`
    )
    .all();
}

export function allAlarms(limit = 300) {
  return db
    .prepare(
      `SELECT a.*, r.code AS room_code, r.name AS room_name, r.kind AS room_kind
       FROM alarms a JOIN rooms r ON r.id = a.room_id
       ORDER BY a.created_at DESC LIMIT ?`
    )
    .all(limit);
}

export function activeAlarmOfRoom(roomId, type) {
  return db
    .prepare(
      `SELECT * FROM alarms WHERE room_id = ? AND type = ? AND status != 'recovered'
       ORDER BY id DESC LIMIT 1`
    )
    .get(roomId, type);
}

export function listTasks(status) {
  const sql = `
    SELECT t.*, r.code AS room_code, r.name AS room_name,
           a.type AS alarm_type, a.level AS alarm_level, a.status AS alarm_status
    FROM tasks t
    JOIN rooms r ON r.id = t.room_id
    JOIN alarms a ON a.id = t.alarm_id
    ${status ? 'WHERE t.status = ?' : ''}
    ORDER BY
      CASE t.status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1
                    WHEN 'processing' THEN 2 WHEN 'done' THEN 3 ELSE 4 END,
      t.priority DESC, t.created_at DESC`;
  return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
}

export function insertReading(roomId, temp, ts) {
  db.prepare('INSERT INTO readings (room_id, temp, recorded_at) VALUES (?,?,?)').run(
    roomId,
    temp,
    ts
  );
}

export function readingsSince(roomId, sinceTs, limit = 4000) {
  return db
    .prepare(
      `SELECT temp, recorded_at AS time FROM readings
       WHERE room_id = ? AND recorded_at >= ?
       ORDER BY recorded_at ASC LIMIT ?`
    )
    .all(roomId, sinceTs, limit);
}
