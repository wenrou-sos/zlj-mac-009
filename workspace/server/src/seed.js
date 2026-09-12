import db, { now, insertReading } from './db.js';

// 冷库档案：id 自增；上下限即告警阈值
const ROOMS = [
  { code: 'A-01', name: '一号冷冻库',   zone: 'A区', kind: '冷冻库', min_temp: -22, max_temp: -16, target_temp: -20, volume: 1200, sensor_code: 'SEN-A01' },
  { code: 'A-02', name: '二号冷冻库',   zone: 'A区', kind: '冷冻库', min_temp: -22, max_temp: -16, target_temp: -19, volume: 980,  sensor_code: 'SEN-A02' },
  { code: 'B-01', name: '生鲜冷藏库',   zone: 'B区', kind: '冷藏库', min_temp: 2,   max_temp: 8,   target_temp: 4,   volume: 1500, sensor_code: 'SEN-B01' },
  { code: 'B-02', name: '果蔬保鲜库',   zone: 'B区', kind: '冷藏库', min_temp: 3,   max_temp: 9,   target_temp: 6,   volume: 860,  sensor_code: 'SEN-B02' },
  { code: 'C-01', name: '深冷存储库',   zone: 'C区', kind: '深冷库', min_temp: -32, max_temp: -24, target_temp: -28, volume: 600,  sensor_code: 'SEN-C01' },
  { code: 'C-02', name: '速冻隧道库',   zone: 'C区', kind: '速冻库', min_temp: -38, max_temp: -30, target_temp: -35, volume: 720,  sensor_code: 'SEN-C02' },
  { code: 'D-01', name: '药品恒温库',   zone: 'D区', kind: '恒温库', min_temp: 15,  max_temp: 22,  target_temp: 18,  volume: 420,  sensor_code: 'SEN-D01' },
  { code: 'D-02', name: '疫苗冷库',     zone: 'D区', kind: '冷藏库', min_temp: 2,   max_temp: 8,   target_temp: 5,   volume: 380,  sensor_code: 'SEN-D02' },
];

const TICK_MS = 5000;          // 每 5 秒采样一次
const HISTORY_HOURS = 72;

export function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c;
  if (count > 0) return false;

  const insertRoom = db.prepare(`
    INSERT INTO rooms (code,name,zone,kind,min_temp,max_temp,target_temp,volume,sensor_code,status,current_temp,last_report_at,created_at)
    VALUES (@code,@name,@zone,@kind,@min_temp,@max_temp,@target_temp,@volume,@sensor_code,'online',@current_temp,@last_report_at,@created_at)
  `);
  const ts = now();
  for (const r of ROOMS) {
    insertRoom.run({ ...r, current_temp: r.target_temp, last_report_at: ts, created_at: ts });
  }

  // 回填最近 72 小时历史读数（约 41.5 万行），带昼夜负载波动 + 随机噪声；事务批量写入
  const rooms = db.prepare('SELECT * FROM rooms').all();
  const start = ts - HISTORY_HOURS * 3600 * 1000;
  const insertReading = db.prepare('INSERT INTO readings (room_id, temp, recorded_at) VALUES (?,?,?)');
  const updateRoom = db.prepare('UPDATE rooms SET current_temp = ? WHERE id = ?');

  const txn = db.transaction(() => {
    for (const room of rooms) {
      const drift = (room.id % 3 === 0 ? 0.6 : 0); // 部分冷库轻微偏温
      let latest = room.target_temp;
      for (let t = start; t <= ts; t += TICK_MS) {
        const hour = new Date(t).getHours();
        const daily = Math.sin(((hour - 4) / 24) * Math.PI * 2) * 0.8; // 白天开门/负载高时温度略升
        const noise = (Math.random() - 0.5) * 0.35;
        const temp = +(room.target_temp + daily + drift + noise).toFixed(2);
        insertReading.run(room.id, temp, t);
        latest = temp;
      }
      updateRoom.run(latest, room.id);
    }
  });
  txn();

  // 清理超出保留窗口的读数
  pruneReadings();
  return true;
}

export function pruneReadings() {
  const cutoff = now() - HISTORY_HOURS * 3600 * 1000;
  db.prepare('DELETE FROM readings WHERE recorded_at < ?').run(cutoff);
}

export { TICK_MS, HISTORY_HOURS };
