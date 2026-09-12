import React, { useState, useMemo } from 'react';
import { useStore } from '../store.jsx';
import RoomCard from './RoomCard.jsx';
import RoomDetail from './RoomDetail.jsx';

export default function Dashboard() {
  const { rooms, alarms, stats } = useStore();
  const [detailId, setDetailId] = useState(null);
  const [zone, setZone] = useState('全部');

  const zones = useMemo(() => ['全部', ...new Set(rooms.map((r) => r.zone))], [rooms]);
  const visible = zone === '全部' ? rooms : rooms.filter((r) => r.zone === zone);

  const activeAlarms = alarms.filter((a) => a.status !== 'recovered');
  const urgent = activeAlarms.filter((a) => a.level >= 3).length;

  const cards = [
    { label: '冷库总数', value: stats?.total ?? rooms.length, icon: '🏭', cls: 'info' },
    {
      label: '在线监控',
      value: stats?.online ?? 0,
      suffix: stats?.offline ? ` / 离线 ${stats.offline}` : '',
      icon: '📡',
      cls: stats?.offline ? 'warn' : 'ok',
    },
    {
      label: '待上报（新建档）',
      value: stats?.noData ?? 0,
      icon: '🆕',
      cls: stats?.noData ? 'warn' : '',
    },
    { label: '温度异常', value: stats?.abnormal ?? 0, icon: '🌡️', cls: stats?.abnormal ? 'danger' : 'ok' },
    { label: '活动告警', value: activeAlarms.length, icon: '🚨', cls: activeAlarms.length ? 'danger' : '', urgent },
    { label: '进行中工单', value: stats?.pendingTasks ?? 0, icon: '🔧', cls: stats?.pendingTasks ? 'warn' : 'ok' },
  ];

  return (
    <div>
      <div className="page-title">
        <div>
          <h2>实时温度监控</h2>
          <div className="sub">每 5 秒采集一次 · WebSocket 实时推送 · 点击冷库卡片查看历史曲线</div>
        </div>
        <div className="seg">
          {zones.map((z) => (
            <button key={z} className={zone === z ? 'active' : ''} onClick={() => setZone(z)}>{z}</button>
          ))}
        </div>
      </div>

      <div className="stats-row">
        {cards.map((c) => (
          <div key={c.label} className={`stat-card ${c.cls}`}>
            <span className="ic">{c.icon}</span>
            <div className="label">{c.label}</div>
            <div className="value">
              {c.value}
              {c.suffix && <span className="unit">{c.suffix}</span>}
              {c.urgent > 0 && <span className="badge red" style={{ marginLeft: 8, verticalAlign: 'middle' }}>{c.urgent} 紧急</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="rooms-grid">
        {visible.map((room) => (
          <RoomCard key={room.id} room={room} onOpen={(r) => setDetailId(r.id)} />
        ))}
      </div>

      {detailId != null && <RoomDetail roomId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
