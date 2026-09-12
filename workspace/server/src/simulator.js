import db, { now, listRooms, insertReading, getRoom } from './db.js';
import { TICK_MS } from './seed.js';
import { evaluateTemperature, markOffline, markOnline } from './alarms.js';
import { hub } from './ws.js';

/**
 * 本地温度模拟接口：
 *  - 每个冷库维护独立的运行状态（目标偏移、随机游走、掉线倒计时）
 *  - 每 TICK_MS 采样一次，写入 readings，并交给告警引擎判定
 *  - 支持通过 triggerEvent 注入故障场景（演示用）
 */
const state = new Map();

function stateOf(room) {
  if (!state.has(room.id)) {
    state.set(room.id, {
      bias: 0,          // 当前温度偏移（故障引起）
      biasTarget: 0,    // 偏移目标值，每 tick 平滑逼近
      walk: 0,          // 随机游走分量
      forceOffline: false,
      dropoutTicks: 0,  // 自发性通信抖动剩余 tick 数
    });
  }
  return state.get(room.id);
}

function dailyWave(date) {
  const hour = date.getHours() + date.getMinutes() / 60;
  // 白班开门作业多，温度略高；凌晨最低
  return Math.sin(((hour - 4) / 24) * Math.PI * 2) * 0.8;
}

const EVENTS = {
  door_open:      { label: '库门长时间开启', biasTarget: 7 },
  cooling_fault:  { label: '制冷机组故障',   biasTarget: 13 },
  low_temp_fault: { label: '温控阀异常持续制冷', biasTarget: -7 },
};

// 对外的"模拟数据接口"：注入故障 / 恢复
export function triggerEvent(roomId, eventType) {
  let room;
  if (roomId) {
    room = getRoom(roomId);
  } else {
    const rooms = listRooms();
    room = rooms[Math.floor(Math.random() * rooms.length)];
  }
  if (!room) return null;

  const s = stateOf(room);
  let detail = '';

  if (eventType === 'offline') {
    s.forceOffline = true;
    detail = '传感器断电';
  } else if (eventType === 'recover') {
    s.biasTarget = 0;
    s.forceOffline = false;
    s.dropoutTicks = 0;
    s.walk = 0;
    detail = '故障排除，设备恢复';
  } else if (EVENTS[eventType]) {
    s.biasTarget = EVENTS[eventType].biasTarget;
    detail = EVENTS[eventType].label;
  } else {
    return null;
  }

  hub.broadcast('sim:event', { roomId: room.id, roomName: room.name, eventType, detail });
  return { roomId: room.id, roomName: room.name, eventType, detail };
}

function tick() {
  const ts = now();
  const date = new Date(ts);
  const wave = dailyWave(date);

  for (const room of listRooms()) {
    const s = stateOf(room);

    // ---- 离线路径：不产生读数 ----
    if (s.forceOffline || s.dropoutTicks > 0) {
      if (room.status === 'online') {
        markOffline(room.id, s.forceOffline ? '信号中断' : '通信抖动');
      }
      if (s.dropoutTicks > 0) s.dropoutTicks -= 1;
      if (!s.forceOffline && s.dropoutTicks === 0 && room.status === 'offline') {
        markOnline(room.id); // 自发性抖动恢复
      }
      continue;
    }

    // ---- 在线路径 ----
    if (room.status === 'offline') markOnline(room.id);

    // 偏移平滑逼近目标（模拟库温升降的惯性）
    const delta = s.biasTarget - s.bias;
    s.bias += Math.max(-1.2, Math.min(1.2, delta));

    // 随机游走 + 测量噪声
    s.walk = s.walk * 0.9 + (Math.random() - 0.5) * 0.2;
    const noise = (Math.random() - 0.5) * 0.35;
    const temp = +(room.target_temp + wave + s.bias + s.walk + noise).toFixed(2);

    insertReading(room.id, temp, ts);
    db.prepare('UPDATE rooms SET current_temp=?, last_report_at=? WHERE id=?')
      .run(temp, ts, room.id);

    evaluateTemperature({ ...room, current_temp: temp, status: 'online' });

    // 极小概率自发性无线抖动，持续 2~7 个 tick（演示传感器离线）
    if (!s.forceOffline && Math.random() < 0.0025) {
      s.dropoutTicks = 2 + Math.floor(Math.random() * 6);
    }
  }

  hub.broadcast('tick', { ts, rooms: listRooms() });
}

export function startSimulator() {
  for (const room of listRooms()) stateOf(room);
  return setInterval(tick, TICK_MS);
}

export { TICK_MS };
