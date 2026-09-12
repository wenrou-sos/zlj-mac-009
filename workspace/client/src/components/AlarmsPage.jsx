import React, { useState } from 'react';
import { useStore } from '../store.jsx';
import { api, fmtTime } from '../api.js';
import { ALARM_TYPE, LEVEL } from '../labels.js';

export default function AlarmsPage() {
  const { alarms, act } = useStore();
  const [tab, setTab] = useState('active');

  const active = alarms.filter((a) => a.status !== 'recovered');
  const history = alarms.filter((a) => a.status === 'recovered');
  const list = tab === 'active' ? active : history;

  const ack = async (a) => {
    const by = window.prompt('确认受理该告警（确认后告警将停止自动升级）', '值班员');
    if (by == null) return;
    await act(() => api.post(`/alarms/${a.id}/ack`, { by }), `告警 #${a.id} 已受理`);
  };

  const sorted = [...list].sort((a, b) =>
    tab === 'active'
      ? b.level - a.level || b.created_at - a.created_at
      : (b.recovered_at || 0) - (a.recovered_at || 0)
  );

  return (
    <div>
      <div className="page-title">
        <div>
          <h2>告警中心</h2>
          <div className="sub">活动告警 {active.length} 条 · 未受理告警每 90 秒自动升级（一般 → 重要 → 紧急）</div>
        </div>
        <div className="seg">
          <button className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>
            活动告警 ({active.length})
          </button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
            已恢复 ({history.length})
          </button>
        </div>
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th style={{ width: 90 }}>级别</th>
              <th style={{ width: 110 }}>类型</th>
              <th style={{ width: 150 }}>冷库</th>
              <th style={{ width: 170 }}>触发值 / 阈值</th>
              <th>告警信息</th>
              <th style={{ width: 170 }}>状态</th>
              <th style={{ width: 165 }}>{tab === 'active' ? '触发时间' : '恢复时间'}</th>
              <th style={{ width: 110 }}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => {
              const t = ALARM_TYPE[a.type];
              return (
                <tr key={a.id}>
                  <td>
                    <span className={`badge ${LEVEL[a.level].cls}`} style={{ fontWeight: 700 }}>
                      L{a.level} {LEVEL[a.level].label}
                    </span>
                    {a.escalated_at && <div className="dim" style={{ marginTop: 3 }}>已升级</div>}
                  </td>
                  <td><span className={`badge ${t.cls}`}>{t.label}</span></td>
                  <td>{a.room_name}<div className="dim">{a.room_code} · {a.room_kind}</div></td>
                  <td className="mono">
                    {a.value != null ? (
                      <span className={a.type === 'high_temp' ? 'temp-color-alarm' : ''}>
                        {a.value}℃ <span className="dim">/ {a.threshold}℃</span>
                      </span>
                    ) : <span className="dim">—</span>}
                  </td>
                  <td>{a.message}</td>
                  <td>
                    {a.status === 'active' && <span className="badge red">未受理</span>}
                    {a.status === 'acked' && (
                      <span className="badge blue">已受理 · {a.acked_by}</span>
                    )}
                    {a.status === 'recovered' && <span className="badge green">已恢复</span>}
                  </td>
                  <td className="dim mono">
                    {fmtTime(tab === 'active' ? a.created_at : a.recovered_at)}
                  </td>
                  <td>
                    <div className="cell-actions">
                      {a.status === 'active' && (
                        <button className="btn-sm btn-primary" onClick={() => ack(a)}>确认受理</button>
                      )}
                      {a.status === 'acked' && <span className="dim">处理中…</span>}
                      {a.status === 'recovered' && <span className="dim">已闭环</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div className="empty">
            <div className="big">✅</div>
            {tab === 'active' ? '当前没有活动告警，所有冷库运行正常' : '暂无历史告警'}
          </div>
        )}
      </div>
    </div>
  );
}
