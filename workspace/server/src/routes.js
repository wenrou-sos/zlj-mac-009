import { Router } from 'express';
import db, {
  listRooms, getRoom, readingsSince, activeAlarms, allAlarms,
  listTasks, now, getSettings, setSetting, effectiveSchedule,
  DEFAULT_REPORT_INTERVAL_MS, DEFAULT_OFFLINE_TIMEOUT_MS,
} from './db.js';
import { triggerEvent } from './simulator.js';
import { reconcileTempAlarms } from './alarms.js';
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
  // 全局变更后，按冷库覆盖值 + 新全局继承值组合出的生效参数也必须合法，
  // 否则"只覆盖超时"或"只覆盖周期"的冷库会悄悄变成超时 < 周期
  const conflicts = listRooms()
    .map((r) => ({
      name: r.name,
      effInterval: r.report_interval_ms ?? interval,
      effTimeout: r.offline_timeout_ms ?? timeout,
    }))
    .filter((c) => c.effTimeout < c.effInterval);
  if (conflicts.length) {
    return res.status(400).json({
      error:
        `保存后以下冷库的超时阈值将小于上报周期：${conflicts
          .map((c) => `${c.name}（周期 ${(c.effInterval / 1000).toFixed(0)}s / 超时 ${(c.effTimeout / 1000).toFixed(0)}s）`)
          .join('、')}。请先在下方按冷库调整或恢复继承。`,
    });
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

// ---------- 冷库档案维护 ----------
const KINDS = ['冷冻库', '冷藏库', '深冷库', '速冻库', '恒温库'];
const TEMP_BOUNDS = { min: -60, max: 40 };
const VOLUME_BOUNDS = { min: 10, max: 100000 };

const trim = (v, max = 30) => String(v ?? '').trim().slice(0, max);

// 校验/规整档案字段。partial=true 时仅校验出现的字段（编辑），温区关系按合并后的最终值校验
function validateRoomPayload(body, existing = null, partial = false) {
  const pick = (key, fallback) => {
    if (Object.prototype.hasOwnProperty.call(body, key)) return body[key];
    return existing ? existing[key] : fallback;
  };
  const code = trim(pick('code', ''), 20);
  const name = trim(pick('name', ''), 30);
  const zone = trim(pick('zone', ''), 10);
  const kind = trim(pick('kind', ''), 10);
  const sensor_code = trim(pick('sensor_code', ''), 30);
  const min_temp = Number(pick('min_temp', NaN));
  const max_temp = Number(pick('max_temp', NaN));
  const target_temp = Number(pick('target_temp', NaN));
  const volume = Number(pick('volume', NaN));

  const errors = [];
  if (!partial || Object.hasOwn(body, 'code')) { if (!code) errors.push('冷库编号不能为空'); }
  if (!partial || Object.hasOwn(body, 'name')) { if (!name) errors.push('冷库名称不能为空'); }
  if (!partial || Object.hasOwn(body, 'zone')) { if (!zone) errors.push('库区不能为空'); }
  if (!partial || Object.hasOwn(body, 'sensor_code')) { if (!sensor_code) errors.push('传感器编号不能为空'); }
  if (!partial || Object.hasOwn(body, 'kind')) {
    if (!KINDS.includes(kind)) errors.push(`冷库类型必须为：${KINDS.join(' / ')}`);
  }
  const checkRange = (label, v) => {
    if (!Number.isFinite(v)) errors.push(`${label}必须是数字`);
    else if (v < TEMP_BOUNDS.min || v > TEMP_BOUNDS.max) {
      errors.push(`${label}允许范围 ${TEMP_BOUNDS.min}℃ ~ ${TEMP_BOUNDS.max}℃`);
    }
  };
  checkRange('下限温度', min_temp);
  checkRange('上限温度', max_temp);
  checkRange('目标温度', target_temp);
  if (!Number.isFinite(volume) || volume < VOLUME_BOUNDS.min || volume > VOLUME_BOUNDS.max) {
    errors.push(`容积允许范围 ${VOLUME_BOUNDS.min} ~ ${VOLUME_BOUNDS.max} m³`);
  }
  if (errors.length === 0) {
    if (min_temp >= max_temp) errors.push('下限温度必须严格小于上限温度');
    if (target_temp < min_temp || target_temp > max_temp) {
      errors.push(`目标温度必须落在 [${min_temp}℃, ${max_temp}℃] 区间内`);
    }
    if (max_temp - min_temp < 1) errors.push('温区上下限至少相差 1℃');
  }
  if (errors.length) return { error: errors.join('；') };

  return { data: { code, name, zone, kind, sensor_code, min_temp, max_temp, target_temp, volume } };
}

// 编号唯一性（编辑时排除自身）
function assertUnique({ code, sensor_code }, exceptId = null) {
  const byCode = db.prepare('SELECT id, name FROM rooms WHERE code = ?').get(code);
  if (byCode && byCode.id !== exceptId) {
    return `冷库编号「${code}」已被「${byCode.name}」占用`;
  }
  const bySensor = db.prepare('SELECT id, name FROM rooms WHERE sensor_code = ?').get(sensor_code);
  if (bySensor && bySensor.id !== exceptId) {
    return `传感器编号「${sensor_code}」已被「${bySensor.name}」占用`;
  }
  return null;
}

// 新增冷库（上线前没有读数，看门狗不会误判，曲线与温度为空）
router.post('/rooms', (req, res) => {
  const check = validateRoomPayload(req.body, null, false);
  if (check.error) return res.status(400).json({ error: check.error });
  const dup = assertUnique(check.data);
  if (dup) return res.status(409).json({ error: dup });

  const ts = now();
  const info = db.prepare(`
    INSERT INTO rooms (code,name,zone,kind,min_temp,max_temp,target_temp,volume,sensor_code,
                       status,current_temp,last_report_at,created_at)
    VALUES (@code,@name,@zone,@kind,@min_temp,@max_temp,@target_temp,@volume,@sensor_code,
            'online',NULL,NULL,@created_at)
  `).run({ ...check.data, created_at: ts });
  const room = getRoom(info.lastInsertRowid);
  hub.broadcast('room:new', room);
  hub.broadcast('toast', { level: 'info', text: `新冷库「${room.name}」（${room.code}）已建档，等待探头上报数据` });
  res.status(201).json({ ...room, effective_schedule: effectiveSchedule(room) });
});

// 编辑档案 / 温区
router.put('/rooms/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getRoom(id);
  if (!existing) return res.status(404).json({ error: '冷库不存在' });

  const check = validateRoomPayload(req.body, existing, true);
  if (check.error) return res.status(400).json({ error: check.error });
  const dup = assertUnique(check.data, id);
  if (dup) return res.status(409).json({ error: dup });

  const d = check.data;
  db.prepare(`
    UPDATE rooms SET code=@code, name=@name, zone=@zone, kind=@kind, sensor_code=@sensor_code,
                     min_temp=@min_temp, max_temp=@max_temp, target_temp=@target_temp, volume=@volume
    WHERE id=@id
  `).run({ ...d, id });

  const updated = getRoom(id);
  hub.broadcast('room:update', updated);

  // 关键：温区改完立即按新阈值重算活动温度告警，不允许留下与新阈值矛盾的告警
  const rangeChanged =
    d.min_temp !== existing.min_temp ||
    d.max_temp !== existing.max_temp ||
    d.target_temp !== existing.target_temp;
  if (rangeChanged) {
    reconcileTempAlarms(updated, '温区阈值已调整，告警按新阈值复核');
  }
  res.json({ ...updated, effective_schedule: effectiveSchedule(updated) });
});

// 删除冷库（告警/工单/读数通过外键级联删除）
router.delete('/rooms/:id', (req, res) => {
  const id = Number(req.params.id);
  const room = getRoom(id);
  if (!room) return res.status(404).json({ error: '冷库不存在' });
  db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  hub.broadcast('room:remove', { id });
  hub.broadcast('toast', { level: 'warning', text: `冷库「${room.name}」及其历史数据、告警与工单已删除` });
  res.json({ ok: true });
});

router.get('/rooms/:id', (req, res) => {
  const room = getRoom(Number(req.params.id));
  if (!room) return res.status(404).json({ error: '冷库不存在' });
  res.json({ ...room, effective_schedule: effectiveSchedule(room) });
});

router.get('/rooms/:id/history', (req, res) => {
  const room = getRoom(Number(req.params.id));
  if (!room) return res.status(404).json({ error: '冷库不存在' });
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 72);
  const since = now() - hours * HOUR_MS;
  const points = readingsSince(room.id, since);

  // 实际数据可能短于请求窗口（例如系统刚启动 / 数据保留窗口限制），明确返回覆盖范围，
  // 避免前端画出"看起来完整、实际只有一段"的曲线而没有任何提示
  const oldest = db
    .prepare('SELECT MIN(recorded_at) AS t FROM readings WHERE room_id = ?')
    .get(room.id).t;
  const availableFrom = oldest || now();
  const effectiveSince = Math.max(since, availableFrom);
  return res.json({
    room,
    min_temp: room.min_temp,
    max_temp: room.max_temp,
    requested_hours: hours,
    retention_hours: 72,
    available_from: availableFrom,
    covered_from: points[0]?.time ?? effectiveSince,
    covered_to: points[points.length - 1]?.time ?? now(),
    partial: points.length > 0 && points[0].time - since > 60_000,
    points,
  });
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
  const reporting = rooms.filter((r) => r.current_temp != null);
  const inRange = reporting.filter(
    (r) => r.status === 'online' && r.current_temp >= r.min_temp && r.current_temp <= r.max_temp
  ).length;
  const noData = rooms.filter((r) => r.status === 'online' && r.current_temp == null).length;
  const abnormal = online - inRange - noData;
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
    abnormal,
    noData,
    activeAlarms: activeAlarmCount.c,
    urgentAlarms: activeAlarmCount.urgent || 0,
    pendingTasks,
  });
});
