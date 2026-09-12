import React, { useEffect, useState, useCallback } from 'react';
import {
  ResponsiveContainer, ComposedChart, Area, Line, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, Brush,
} from 'recharts';
import { api, fmtTime, fmtHM } from '../api.js';
import { useStore } from '../store.jsx';
import { roomAlarmLevel, LEVEL, ALARM_TYPE } from '../labels.js';

const RANGES = [
  { h: 1, label: '近1小时' },
  { h: 6, label: '近6小时' },
  { h: 24, label: '近24小时' },
];

export default function RoomDetail({ roomId, onClose }) {
  const { rooms, alarms } = useStore();
  const [hours, setHours] = useState(1);
  const [data, setData] = useState(null);

  const room = rooms.find((r) => r.id === roomId);

  const load = useCallback(async () => {
    const d = await api.get(`/rooms/${roomId}/history?hours=${hours}`);
    setData(d);
  }, [roomId, hours]);

  useEffect(() => { load(); }, [load]);

  // 每 5 秒跟随新读数刷新
  useEffect(() => {
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const roomAlarms = alarms.filter((a) => a.room_id === roomId && a.status !== 'recovered');
  const lv = roomAlarmLevel(alarms, roomId);

  const tip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    return (
      <div style={{
        background: '#0f1a2e', border: '1px solid #24375c', borderRadius: 8,
        padding: '7px 11px', fontSize: 12,
      }}>
        <div style={{ color: '#8ea3c4' }}>{fmtTime(p.time)}</div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{p.temp.toFixed(2)} ℃</div>
      </div>
    );
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <span style={{ fontSize: 22 }}>🏭</span>
          <div>
            <h3>{room?.name} · 温度历史曲线</h3>
            <div className="dim">{room?.code} · {room?.kind} · 传感器 {room?.sensor_code}</div>
          </div>
          <span style={{ marginLeft: 12 }}>
            {room?.status === 'offline'
              ? <span className="badge gray">传感器离线</span>
              : lv
                ? <span className={`badge ${LEVEL[lv].cls}`}>{LEVEL[lv].label}告警中</span>
                : <span className="badge green">运行正常</span>}
          </span>
          <button className="btn-sm btn-ghost x" onClick={onClose}>✕ 关闭</button>
        </div>

        <div className="modal-body">
          <div className="detail-meta">
            <div className="cell">
              <div className="l">当前温度</div>
              <div className="v">{room?.current_temp != null ? `${room.current_temp.toFixed(2)} ℃` : '—'}</div>
            </div>
            <div className="cell">
              <div className="l">允许区间</div>
              <div className="v">{room?.min_temp} ~ {room?.max_temp} ℃</div>
            </div>
            <div className="cell">
              <div className="l">设定目标</div>
              <div className="v">{room?.target_temp} ℃</div>
            </div>
            <div className="cell">
              <div className="l">最后上报</div>
              <div className="v" style={{ fontSize: 14 }}>{fmtTime(room?.last_report_at)}</div>
            </div>
          </div>

          <div className="panel-head" style={{ padding: '0 0 12px' }}>
            <div className="seg">
              {RANGES.map((r) => (
                <button key={r.h} className={hours === r.h ? 'active' : ''} onClick={() => setHours(r.h)}>
                  {r.label}
                </button>
              ))}
            </div>
            <div className="spacer" />
            <div className="legend">
              <span><i style={{ background: '#f87171' }} />上限 {data?.max_temp}℃</span>
              <span><i style={{ background: '#7dd3fc' }} />下限 {data?.min_temp}℃</span>
              <span><i style={{ background: 'rgba(34,197,94,.35)' }} />正常温区</span>
            </div>
          </div>

          <div style={{ width: '100%', height: 300 }}>
            {data && data.points.length > 1 ? (
              <ResponsiveContainer>
                <ComposedChart data={data.points} margin={{ top: 8, right: 12, bottom: 0, left: -14 }}>
                  <defs>
                    <linearGradient id="tempFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1c2c4c" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="time" tickFormatter={hours > 6 ? (t) => fmtHM(t).slice(0, 2) + '时' : fmtHM}
                    stroke="#5f7396" fontSize={11} minTickGap={40}
                  />
                  <YAxis
                    stroke="#5f7396" fontSize={11}
                    domain={[data.min_temp - 3, data.max_temp + 3]}
                    tickCount={8}
                  />
                  <Tooltip content={tip} />
                  <ReferenceLine y={data.max_temp} stroke="#f87171" strokeDasharray="6 4" strokeWidth={1.4} />
                  <ReferenceLine y={data.min_temp} stroke="#7dd3fc" strokeDasharray="6 4" strokeWidth={1.4} />
                  <Area
                    type="monotone" dataKey="temp" stroke="none"
                    fill="url(#tempFill)" isAnimationActive={false}
                  />
                  <Line
                    type="monotone" dataKey="temp" stroke="#38bdf8" strokeWidth={2}
                    dot={false} isAnimationActive={false}
                  />
                  {hours >= 6 && <Brush
                    dataKey="time" height={22} stroke="#38bdf8"
                    fill="#0f1a2e" tickFormatter={fmtHM} travellerWidth={8}
                  />}
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty"><div className="big">📉</div>该时间范围内暂无读数</div>
            )}
          </div>

          {roomAlarms.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="dim" style={{ marginBottom: 6 }}>当前活动告警</div>
              {roomAlarms.map((a) => (
                <span key={a.id} className={`badge ${LEVEL[a.level].cls}`} style={{ marginRight: 8 }}>
                  #{a.id} {ALARM_TYPE[a.type]?.label} · L{a.level} {LEVEL[a.level].label}
                  {a.status === 'acked' ? ` · ${a.acked_by}已受理` : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
