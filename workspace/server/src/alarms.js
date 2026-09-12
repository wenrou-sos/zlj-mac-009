import db, {
  now, activeAlarmOfRoom, getRoom, listRooms,
  recordReading, effectiveSchedule,
} from './db.js';
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

// ---------- 离线判定（心跳超时看门狗） ----------
// 按各冷库生效的超时阈值检查最后上报时间：短暂丢包（未超时）视为抖动，不产生告警
export function runOfflineWatchdog(ts = now()) {
  for (const room of listRooms()) {
    if (room.status === 'offline' || room.last_report_at == null) continue;
    const { timeout } = effectiveSchedule(room);
    if (ts - room.last_report_at > timeout) {
      const missed = Math.round((ts - room.last_report_at) / effectiveSchedule(room).interval);
      markOffline(room.id, `心跳超时（连续约 ${missed} 个周期未上报，阈值 ${Math.round(timeout / 1000)}s）`);
    }
  }
}

// ---------- 离线 ----------
export function markOffline(roomId, reason = '心跳超时') {
  const room = getRoom(roomId);
  if (!room || room.status === 'offline') return;
  db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('offline', roomId);
  hub.broadcast('room:update', db.prepare('SELECT * FROM rooms WHERE id=?').get(roomId));
  // 同一离线过程只告警一次：恢复上线后再次掉线才会重新生成告警与工单
  if (!activeAlarmOfRoom(roomId, 'sensor_offline')) {
    createAlarm({ ...room, status: 'offline' }, 'sensor_offline', null, null,
      `传感器 ${room.sensor_code} ${reason}`);
  }
}

/**
 * 统一读数入口（心跳）：模拟器和未来的真实网关都走这里。
 *  - 在线：入库并做温度判定
 *  - 离线中收到读数：立即上线、解除离线告警/工单恢复，再判定温度
 * 没有读数进来就不会更新 last_report_at，看门狗因此可以检出真实断连。
 */
export function ingestReading(roomId, temp, ts = now()) {
  const room = getRoom(roomId);
  if (!room) return;
  const wasOffline = room.status === 'offline';
  recordReading(roomId, temp, ts);
  const updated = getRoom(roomId);

  if (wasOffline) {
    hub.broadcast('room:update', updated);
    recoverRoomAlarms(roomId, ['sensor_offline'], '传感器恢复上报');
    hub.broadcast('toast', { level: 'success', text: `${room.name} 传感器已恢复上线` });
  }
  // 只有真正收到新读数才做温度判定，离线期间不会用陈旧温度重复越限
  evaluateTemperature(updated);
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
