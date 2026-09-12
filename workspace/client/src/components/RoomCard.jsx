import React, { useState, useRef, useEffect } from 'react';
import Sparkline from './Sparkline.jsx';
import { api, ago } from '../api.js';
import { useStore } from '../store.jsx';
import { roomAlarmLevel, tempColorCls, SIM_EVENTS, LEVEL } from '../labels.js';

export default function RoomCard({ room, onOpen }) {
  const { alarms, pushToast } = useStore();
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef(null);
  const lv = roomAlarmLevel(alarms, room.id);
  const offline = room.status === 'offline';

  useEffect(() => {
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const fireEvent = async (type) => {
    setMenuOpen(false);
    try {
      const r = await api.post(`/sim/rooms/${room.id}/event`, { type });
      pushToast('info', `[模拟] ${r.roomName}：${r.detail}`);
    } catch (e) {
      pushToast('error', e.message);
    }
  };

  return (
    <div
      className={`room-card ${offline ? 'offline' : ''} ${lv ? `alarm-l${lv}` : ''}`}
      onClick={() => onOpen(room)}
    >
      <div className="rc-head">
        <div>
          <div className="rc-name">{room.name}</div>
          <div className="rc-meta">{room.zone} · {room.code} · {room.kind} · {room.volume}m³</div>
        </div>
        <div onClick={(e) => e.stopPropagation()}>
          <div className="dropdown" ref={ref}>
            <button className="btn-sm btn-ghost" onClick={() => setMenuOpen((v) => !v)}>模拟 ▾</button>
            {menuOpen && (
              <div className="dropdown-menu">
                <div className="dd-title">注入故障 / 恢复</div>
                {SIM_EVENTS.map((ev) => (
                  <button key={ev.type} onClick={() => fireEvent(ev.type)}>{ev.label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={`rc-temp ${offline ? 'offline' : ''}`}>
        {offline ? (
          <span className="num" style={{ fontSize: 22 }}>📵 离线</span>
        ) : (
          <>
            <span className={`num ${tempColorCls(room)}`}>
              {room.current_temp != null ? room.current_temp.toFixed(1) : '—'}
            </span>
            <span className="c">℃</span>
            {lv > 0 && <span className={`badge ${LEVEL[lv].cls}`} style={{ marginLeft: 'auto' }}>
              {LEVEL[lv].label}告警
            </span>}
          </>
        )}
      </div>
      <div className="rc-range">
        允许区间 {room.min_temp}℃ ~ {room.max_temp}℃ · 目标 {room.target_temp}℃
      </div>

      <Sparkline points={room.spark} min={room.min_temp} max={room.max_temp} />

      <div className="rc-foot">
        <span className={`badge ${offline ? 'gray' : 'green'}`}>
          {offline ? '● 传感器离线' : '● 在线'}
        </span>
        <span className="dim">上报于 {ago(room.last_report_at)}</span>
      </div>
    </div>
  );
}
