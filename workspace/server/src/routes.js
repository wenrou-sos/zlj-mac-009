import { Router } from 'express';
import db, {
  listRooms, getRoom, readingsSince, activeAlarms, allAlarms,
  listTasks, now, getSettings, setSetting, effectiveSchedule,
  DEFAULT_REPORT_INTERVAL_MS, DEFAULT_OFFLINE_TIMEOUT_MS,
} from './db.js';
import { triggerEvent } from './simulator.js';
import { hub } from './ws.js';

export const router = Router();

const HOUR_MS = 3600 * 1000;

// ---------- 看板概览：冷库快照 + 迷你曲线 ----------
router.get('/overview', (req, res) => {
  const since = now() - (Number(req.query.minutes) || 60) * 60 * 1000;
  const rooms = listRooms();
  const stmt = db.prepare(
    'SELECT temp, recorded_at AS time FROM readings WHERE room_id=? AND recorded_at>=? ORDER BY recorded_at ASC'
  );
  const data = rooms.map((r) => ({
    ...r,
    effective_schedule: effectiveSchedule(r),
    spark: stmt.all(r.id, since),
  }));
  res.json(data);
});

// ---------- 冷库 ----------
router.get('/rooms', (req, res) => {
  res.json(listRooms().map((r) => ({ ...r, effective_schedule: effectiveSchedule(r) })));
});

// 心跳参数（全局默认 + 各冷库生效值）
router.get('/heartbeat-config', (req, res) => {
  const global = getSettings();
  res.json({
    global,
    defaults: {
      report_interval_ms: DEFAULT_REPORT_INTERVAL_MS,
      offline_timeout_ms: DEFAULT_OFFLINE_TIMEOUT_MS,
    },
    rooms: listRooms().map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      report_interval_ms: r.report_interval_ms,
      offline_timeout_ms: r.offline_timeout_ms,
      effective: effectiveSchedule(r),
    })),
  });
});

// 更新全局心跳参数
router.put('/settings', (req, res) => {
  const parseInt10 = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : null;
  };
  const cur = getSettings();
  const interval = parseInt10(req.body?.report_interval_ms) ?? cur.report_interval_ms;
  const timeout = parseInt10(req.body?.offline_timeout_ms) ?? cur.offline_timeout_ms;
  if (interval < 1000 || interval > 60000) {
    return res.status(400).json({ error: '上报周期允许范围 1~60 秒' });
  }
  if (timeout < 5000 || timeout > 300000) {
    return res.status(400).json({ error: '离线超时阈值允许范围 5~300 秒' });
  }
  if (timeout < interval) {
    return res.status(400).json({ error: '离线超时阈值不能小于上报周期，否则会频繁误报离线' });
  }
  setSetting('report_interval_ms', interval);
  setSetting('offline_timeout_ms', timeout);
  res.json(getSettings());
});

// 按冷库设置心跳覆盖；传 null 表示恢复继承全局
router.put('/rooms/:id/heartbeat', (req, res) => {
  const room = getRoom(Number(req.params.id));
  if (!room) return res.status(404).json({ error: '冷库不存在' });
  const toNullableInt = (v) => (v == null || v === '' ? null : Math.round(Number(v)));
  const interval = toNullableInt(req.body?.report_interval_ms);
  const timeout = toNullableInt(req.body?.offline_timeout_ms);

  const g = getSettings();
  const effInterval = interval ?? g.report_interval_ms;
  const effTimeout = timeout ?? g.offline_timeout_ms;
  if (interval != null && !(interval >= 1000 && interval <= 60000)) {
    return res.status(400).json({ error: '上报周期允许范围 1~60 秒' });
  }
  if (timeout != null && !(timeout >= 5000 && timeout <= 300000)) {
    return res.status(400).json({ error: '超时阈值允许范围 5~300 秒' });
  }
  if (effTimeout < effInterval) {
    return res.status(400).json({ error: '该冷库超时阈值不能小于上报周期' });
  }
  db.prepare('UPDATE rooms SET report_interval_ms=?, offline_timeout_ms=? WHERE id=?')
    .run(interval, timeout, room.id);
  const updated = getRoom(room.id);
  hub.broadcast('room:update', updated);
  res.json({ room: updated, effective: effectiveSchedule(updated) });
});

router.get('/rooms/:id', (req, res) => {
  const room = getRoom(Number(req.params.id));
  if (!room) return res.status(404).json({ error: '冷库不存在' });
  res.json({ ...room, effective_schedule: effectiveSchedule(room) });
});

router.get('/rooms/:id/history', (req, res) => {
  const room = getRoom(Number(req.params.id));
  if (!room) return res.status(404).json({ error: '冷库不存在' });
  const hours = Math.min(Number(req.query.hours) || 24, 72);
  const data = readingsSince(room.id, now() - hours * HOUR_MS);
  res.json({ room, min_temp: room.min_temp, max_temp: room.max_temp, points: data });
});

// ---------- 告警 ----------
router.get('/alarms', (req, res) => {
  res.json(req.query.all === '1' ? allAlarms() : activeAlarms());
});

router.post('/alarms/:id/ack', (req, res) => {
  const alarm = db.prepare('SELECT * FROM alarms WHERE id=?').get(Number(req.params.id));
  if (!alarm) return res.status(404).json({ error: '告警不存在' });
  if (alarm.status === 'recovered') return res.status(409).json({ error: '告警已恢复，无需确认' });
  const by = String(req.body?.by || '值班员').slice(0, 20);
  db.prepare('UPDATE alarms SET status=?, acked_by=?, acked_at=? WHERE id=?')
    .run('acked', by, now(), alarm.id);
  const updated = db.prepare('SELECT * FROM alarms WHERE id=?').get(alarm.id);
  hub.broadcast('alarm:update', updated);
  hub.broadcast('toast', { level: 'info', text: `告警 #${alarm.id} 已由 ${by} 确认受理（不再自动升级）` });
  res.json(updated);
});

// ---------- 维修任务 ----------
router.get('/tasks', (req, res) => {
  res.json(listTasks(req.query.status || null));
});

const getTask = (id) =>
  db.prepare(
    `SELECT t.*, r.code AS room_code, r.name AS room_name,
            a.status AS alarm_status, a.type AS alarm_type, a.level AS alarm_level
     FROM tasks t
     JOIN rooms r ON r.id = t.room_id
     JOIN alarms a ON a.id = t.alarm_id WHERE t.id=?`
  ).get(id);

router.post('/tasks/:id/accept', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'pending') return res.status(409).json({ error: `任务已被接单（当前：${task.status}）` });
  const assignee = String(req.body?.assignee || '维修工').slice(0, 20);
  db.prepare('UPDATE tasks SET status=?, assignee=?, accepted_at=? WHERE id=?')
    .run('accepted', assignee, now(), task.id);
  const updated = getTask(task.id);
  hub.broadcast('task:update', updated);
  hub.broadcast('toast', { level: 'info', text: `${assignee} 已接单：${task.title}` });
  res.json(updated);
});

router.post('/tasks/:id/start', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'accepted') return res.status(409).json({ error: '仅已接单任务可开始维修' });
  db.prepare('UPDATE tasks SET status=?, started_at=? WHERE id=?').run('processing', now(), task.id);
  const updated = getTask(task.id);
  hub.broadcast('task:update', updated);
  res.json(updated);
});

// 完成维修：restored=true 表示现场已排除故障（清除模拟故障，温度/通信开始恢复）
router.post('/tasks/:id/done', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'processing') return res.status(409).json({ error: '仅处理中任务可填报完成' });
  const note = String(req.body?.note || '').slice(0, 200);
  const restored = req.body?.restored !== false;
  db.prepare('UPDATE tasks SET status=?, result_note=?, done_at=? WHERE id=?')
    .run('done', note || '故障已排除', now(), task.id);
  if (restored) triggerEvent(task.room_id, 'recover');
  const updated = getTask(task.id);
  hub.broadcast('task:update', updated);
  hub.broadcast('toast', { level: 'info', text: `任务 #${task.id} 维修完成，等待恢复确认` });
  res.json(updated);
});

// 恢复确认：关联告警必须已恢复（温度回区间 / 传感器上线）才能闭环
router.post('/tasks/:id/confirm', (req, res) => {
  const task = getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== 'done') return res.status(409).json({ error: '仅已完成维修的任务可做恢复确认' });
  if (task.alarm_status !== 'recovered') {
    return res.status(409).json({
      error: task.alarm_type === 'sensor_offline'
        ? '传感器尚未恢复上线，无法闭环'
        : '温度尚未回到正常区间，无法闭环',
    });
  }
  const note = String(req.body?.note || '现场复核正常').slice(0, 200);
  db.prepare('UPDATE tasks SET status=?, confirmed_at=?, result_note=COALESCE(NULLIF(?, \'\'), result_note) WHERE id=?')
    .run('confirmed', now(), note, task.id);
  const updated = getTask(task.id);
  hub.broadcast('task:update', updated);
  hub.broadcast('toast', { level: 'success', text: `任务 #${task.id} 已恢复确认并闭环` });
  res.json(updated);
});

// ---------- 模拟接口（注入故障/恢复场景） ----------
router.post('/sim/rooms/:id/event', (req, res) => {
  const type = String(req.body?.type || '');
  const result = triggerEvent(Number(req.params.id), type);
  if (!result) return res.status(400).json({ error: '不支持的事件类型' });
  res.json(result);
});

router.post('/sim/event', (req, res) => {
  const result = triggerEvent(null, String(req.body?.type || 'cooling_fault'));
  res.json(result);
});

// ---------- 看板统计 ----------
router.get('/stats', (req, res) => {
  const rooms = listRooms();
  const online = rooms.filter((r) => r.status === 'online').length;
  const inRange = rooms.filter(
    (r) => r.status === 'online' && r.current_temp != null &&
      r.current_temp >= r.min_temp && r.current_temp <= r.max_temp
  ).length;
  const activeAlarmCount = db.prepare(
    `SELECT COUNT(*) c, SUM(level>=3) urgent FROM alarms WHERE status!='recovered'`
  ).get();
  const pendingTasks = db.prepare(
    `SELECT COUNT(*) c FROM tasks WHERE status IN ('pending','accepted','processing')`
  ).get().c;
  res.json({
    total: rooms.length,
    online,
    offline: rooms.length - online,
    inRange,
    abnormal: rooms.length - inRange,
    activeAlarms: activeAlarmCount.c,
    urgentAlarms: activeAlarmCount.urgent || 0,
    pendingTasks,
  });
});
