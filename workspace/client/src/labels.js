// 冷库 / 告警 / 工单的展示辅助

export const ALARM_TYPE = {
  high_temp: { label: '温度偏高', cls: 'red' },
  low_temp: { label: '温度偏低', cls: 'cyan' },
  sensor_offline: { label: '传感器离线', cls: 'violet' },
};

export const LEVEL = {
  1: { label: '一般', cls: 'amber' },
  2: { label: '重要', cls: 'orange' },
  3: { label: '紧急', cls: 'red' },
};

export const TASK_STATUS = {
  pending: { label: '待接单', cls: 'gray' },
  accepted: { label: '已接单', cls: 'blue' },
  processing: { label: '维修中', cls: 'amber' },
  done: { label: '待恢复确认', cls: 'violet' },
  confirmed: { label: '已闭环', cls: 'green' },
};

// 汇总某个冷库当前最严重的活动告警等级
export function roomAlarmLevel(alarms, roomId) {
  let lv = 0;
  for (const a of alarms) {
    if (a.room_id === roomId && a.status !== 'recovered') lv = Math.max(lv, a.level);
  }
  return lv;
}

export function tempStatus(room) {
  if (room.status === 'offline' || room.current_temp == null) return 'offline';
  const { current_temp: t, min_temp: min, max_temp: max } = room;
  if (t < min || t > max) return 'alarm';
  if (t < min + 1 || t > max - 1) return 'warn';
  return 'ok';
}

export const tempColorCls = (room) =>
  room.status === 'offline' ? '' : `temp-color-${tempStatus(room)}`;

export const SIM_EVENTS = [
  { type: 'door_open', label: '🔥 库门长时间开启', danger: true },
  { type: 'cooling_fault', label: '💥 模拟制冷机组故障', danger: true },
  { type: 'low_temp_fault', label: '❄️ 模拟温控阀异常（过冷）', danger: true },
  { type: 'offline', label: '📵 模拟传感器离线', danger: true },
  { type: 'recover', label: '✅ 故障排除 / 恢复正常', danger: false },
];
