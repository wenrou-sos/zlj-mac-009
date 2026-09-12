import db, { now, activeAlarmOfRoom, getRoom } from './db.js';
import { hub } from './ws.js';

// 升级规则：未被确认的活动告警按停留时长逐级升级
//  L1 一般 -> L2 重要（默认 90s）-> L3 紧急（再 90s）；可用环境变量调整
export const ESCALATE_AFTER_MS = Number(process.env.ESCALATE_MS) || 90_000;
export const MAX_LEVEL = 3;

const LEVEL_LABEL = { 1: '一般', 2: '重要', 3: '紧急' };
const TYPE_LABEL = { high_temp: '温度偏高', low_temp: '温度偏低', sensor_offline: '传感器离线' };

export const levelLabel = (lv) => LEVEL_LABEL[lv] || `L${lv}`;
export const typeLabel = (t) => TYPE_LABEL[t] || t;

// ---------- 告警创建（自动生成处理任务） ----------
function createAlarm(room, type, value, threshold, message) {
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO alarms (room_id,type,level,value,threshold,message,status,created_at)
       VALUES (?,?,1,?,?,?, 'active', ?)`
    )
    .run(room.id, type, value ?? null, threshold ?? null, message, ts);
  const alarm = db.prepare('SELECT * FROM alarms WHERE id = ?').get(info.lastInsertRowid);

  const taskTitle =
    type === 'sensor_offline'
      ? `维修任务：${room.name} 传感器离线`
      : `处置任务：${room.name} ${TYPE_LABEL[type]}`;
  const taskDesc =
    type === 'sensor_offline'
      ? `传感器 ${room.sensor_code} 信号丢失，请现场检查供电、网关与探头连接，恢复后确认。`
      : `当前温度 ${value}℃，${type === 'high_temp' ? '高于' : '低于'}允许阈值 ${threshold}℃。` +
        `请检查制冷机组、门封与库内货物情况并处置，温度恢复正常后确认闭环。`;

  db.prepare(
    `INSERT INTO tasks (alarm_id,room_id,title,description,priority,status,created_at)
     VALUES (?,?,?,?,1,'pending',?)`
  ).run(alarm.id, room.id, taskTitle, taskDesc, ts);

  const task = db.prepare('SELECT * FROM tasks WHERE alarm_id = ?').get(alarm.id);
  hub.broadcast('alarm:new', { alarm, task });
  hub.broadcast('toast', {
    level: 'error',
    text: `[告警] ${room.name} · ${message}`,
  });
  return alarm;
}

// ---------- 温度阈值判定 ----------
export function evaluateTemperature(room) {
  const temp = room.current_temp;
  if (room.status !== 'online' || temp == null) return;

  if (temp > room.max_temp) {
    const existing = activeAlarmOfRoom(room.id, 'high_temp');
    if (!existing) {
      createAlarm(room, 'high_temp', temp, room.max_temp,
        `温度 ${temp}℃ 超过上限 ${room.max_temp}℃`);
    }
  } else if (temp < room.min_temp) {
    const existing = activeAlarmOfRoom(room.id, 'low_temp');
    if (!existing) {
      createAlarm(room, 'low_temp', temp, room.min_temp,
        `温度 ${temp}℃ 低于下限 ${room.min_temp}℃`);
    }
  } else {
    // 温度回归正常区间：自动恢复该库所有温度类活动告警
    recoverRoomAlarms(room.id, ['high_temp', 'low_temp'], '温度回归正常区间');
  }
}

// ---------- 离线 / 上线 ----------
export function markOffline(roomId, reason = '通信超时') {
  const room = getRoom(roomId);
  if (!room || room.status === 'offline') return;
  db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('offline', roomId);
  if (!activeAlarmOfRoom(roomId, 'sensor_offline')) {
    createAlarm({ ...room, status: 'offline' }, 'sensor_offline', null, null,
      `传感器 ${room.sensor_code} ${reason}`);
  }
}

export function markOnline(roomId) {
  const room = getRoom(roomId);
  if (!room || room.status !== 'offline') return;
  db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('online', roomId);
  recoverRoomAlarms(roomId, ['sensor_offline'], '传感器通信恢复');
  hub.broadcast('room:update', db.prepare('SELECT * FROM rooms WHERE id=?').get(roomId));
  hub.broadcast('toast', { level: 'success', text: `${room.name} 传感器已上线` });
}

// ---------- 恢复 ----------
export function recoverRoomAlarms(roomId, types, reason) {
  const ts = now();
  const placeholders = types.map(() => '?').join(',');
  const alarms = db
    .prepare(
      `SELECT * FROM alarms WHERE room_id = ? AND type IN (${placeholders}) AND status != 'recovered'`
    )
    .all(roomId, ...types);

  for (const alarm of alarms) {
    db.prepare('UPDATE alarms SET status=?, recovered_at=? WHERE id=?').run('recovered', ts, alarm.id);
    hub.broadcast('alarm:recover', { alarmId: alarm.id, roomId, reason });
    hub.broadcast('toast', {
      level: 'success',
      text: `[恢复] ${typeLabel(alarm.type)} · ${reason}`,
    });
  }
}

// ---------- 告警升级轮询 ----------
export function runEscalationSweep() {
  const candidates = db
    .prepare(
      `SELECT a.*, r.name AS room_name FROM alarms a JOIN rooms r ON r.id = a.room_id
       WHERE a.status != 'recovered' AND a.level < ? AND a.acked_at IS NULL`
    )
    .all(MAX_LEVEL);

  const ts = now();
  for (const alarm of candidates) {
    const base = alarm.escalated_at || alarm.created_at;
    if (ts - base >= ESCALATE_AFTER_MS) {
      const nextLevel = alarm.level + 1;
      db.prepare('UPDATE alarms SET level=?, escalated_at=? WHERE id=?')
        .run(nextLevel, ts, alarm.id);
      // 任务优先级与告警等级联动
      db.prepare('UPDATE tasks SET priority=? WHERE alarm_id=? AND status IN (?,?)')
        .run(nextLevel, alarm.id, 'pending', 'accepted');
      hub.broadcast('alarm:escalate', {
        alarmId: alarm.id,
        roomId: alarm.room_id,
        level: nextLevel,
      });
      hub.broadcast('toast', {
        level: nextLevel >= 3 ? 'error' : 'warning',
        text: `[升级] ${alarm.room_name} 告警升级为 ${LEVEL_LABEL[nextLevel]}`,
      });
    }
  }
}
