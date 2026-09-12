import React, { useEffect, useState } from 'react';
import { api, ago } from '../api.js';
import { useStore } from '../store.jsx';

export default function SettingsPage() {
  const { rooms, pushToast, refreshAll } = useStore();
  const [cfg, setCfg] = useState(null);
  const [global, setGlobal] = useState({ interval: 5, timeout: 15 });
  const [overrides, setOverrides] = useState({}); // roomId -> {interval, timeout}
  const [savingGlobal, setSavingGlobal] = useState(false);

  const load = async () => {
    const d = await api.get('/heartbeat-config');
    setCfg(d);
    setGlobal({
      interval: d.global.report_interval_ms / 1000,
      timeout: d.global.offline_timeout_ms / 1000,
    });
    const ov = {};
    for (const r of d.rooms) {
      if (r.report_interval_ms != null || r.offline_timeout_ms != null) {
        ov[r.id] = {
          interval: r.report_interval_ms != null ? r.report_interval_ms / 1000 : '',
          timeout: r.offline_timeout_ms != null ? r.offline_timeout_ms / 1000 : '',
        };
      }
    }
    setOverrides(ov);
  };

  useEffect(() => { load(); }, []);

  const saveGlobal = async () => {
    setSavingGlobal(true);
    try {
      const result = await api.put('/settings', {
        report_interval_ms: Math.round(global.interval * 1000),
        offline_timeout_ms: Math.round(global.timeout * 1000),
      });
      pushToast('success', `全局心跳参数已保存：周期 ${result.report_interval_ms / 1000}s / 超时 ${result.offline_timeout_ms / 1000}s`);
      await load();
      refreshAll();
    } catch (e) {
      pushToast('error', e.message);
    } finally {
      setSavingGlobal(false);
    }
  };

  const saveRoom = async (roomId) => {
    const v = overrides[roomId] || {};
    try {
      await api.put(`/rooms/${roomId}/heartbeat`, {
        report_interval_ms: v.interval === '' || v.interval == null ? null : Math.round(v.interval * 1000),
        offline_timeout_ms: v.timeout === '' || v.timeout == null ? null : Math.round(v.timeout * 1000),
      });
      pushToast('success', '冷库心跳参数已更新');
      await load();
      refreshAll();
    } catch (e) {
      pushToast('error', e.message);
    }
  };

  const resetRoom = async (roomId) => {
    setOverrides((o) => {
      const n = { ...o };
      delete n[roomId];
      return n;
    });
    try {
      await api.put(`/rooms/${roomId}/heartbeat`, { report_interval_ms: null, offline_timeout_ms: null });
      pushToast('success', '已恢复继承全局参数');
      await load();
      refreshAll();
    } catch (e) {
      pushToast('error', e.message);
    }
  };

  const setField = (roomId, field, value) => {
    setOverrides((o) => ({
      ...o,
      [roomId]: { interval: '', timeout: '', ...o[roomId], [field]: value },
    }));
  };

  const cfgRoom = (id) => cfg?.rooms.find((r) => r.id === id);

  return (
    <div>
      <div className="page-title">
        <div>
          <h2>心跳与离线判定参数</h2>
          <div className="sub">
            看门狗每 5 秒扫描一次：冷库超过「离线超时阈值」未收到任何读数即判离线，自动生成离线告警与维修工单；
            恢复上报后自动上线并解除告警。短暂丢包（未超过超时）视为抖动，不重复告警。
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>🌐 全局默认参数</h3>
          <div className="spacer" />
          <button className="btn-primary" disabled={savingGlobal} onClick={saveGlobal}>保存全局参数</button>
        </div>
        <div style={{ padding: '18px 20px', display: 'flex', gap: 36, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: 'var(--text-dim)' }}>期望上报周期</span>
            <input
              type="number" min="1" max="60"
              style={inputStyle}
              value={global.interval}
              onChange={(e) => setGlobal((g) => ({ ...g, interval: e.target.value }))}
            />
            <span className="dim">秒</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: 'var(--text-dim)' }}>离线超时阈值</span>
            <input
              type="number" min="5" max="300"
              style={inputStyle}
              value={global.timeout}
              onChange={(e) => setGlobal((g) => ({ ...g, timeout: e.target.value }))}
            />
            <span className="dim">秒（须 ≥ 上报周期）</span>
          </label>
          <span className="dim" style={{ alignSelf: 'center' }}>
            当前默认 5s 周期 / 15s 超时 ≈ 容忍连续 2 次丢包
          </span>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>🏭 按冷库单独配置（留空 = 继承全局）</h3></div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 150 }}>冷库</th>
              <th style={{ width: 110 }}>状态 / 最后上报</th>
              <th style={{ width: 150 }}>生效周期 (秒)</th>
              <th style={{ width: 150 }}>生效超时 (秒)</th>
              <th style={{ width: 140 }}>自定义周期 (秒)</th>
              <th style={{ width: 140 }}>自定义超时 (秒)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => {
              const c = cfgRoom(r.id);
              const eff = c?.effective || r.effective_schedule || { interval: 5000, timeout: 15000 };
              const v = overrides[r.id] || {};
              const isCustom = c && (c.report_interval_ms != null || c.offline_timeout_ms != null);
              return (
                <tr key={r.id}>
                  <td>
                    {r.name}
                    <div className="dim">{r.code} · {r.sensor_code}</div>
                  </td>
                  <td>
                    <span className={`badge ${r.status === 'offline' ? 'gray' : 'green'}`}>
                      {r.status === 'offline' ? '离线' : '在线'}
                    </span>
                    <div className="dim" style={{ marginTop: 3 }}>{ago(r.last_report_at)}</div>
                  </td>
                  <td className="mono">{(eff.interval / 1000).toFixed(0)}s</td>
                  <td className="mono">
                    {(eff.timeout / 1000).toFixed(0)}s
                    {isCustom && <span className="badge cyan" style={{ marginLeft: 6 }}>已覆盖</span>}
                  </td>
                  <td>
                    <input
                      type="number" min="1" max="60" placeholder="继承"
                      style={inputStyle}
                      value={v.interval ?? ''}
                      onChange={(e) => setField(r.id, 'interval', e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      type="number" min="5" max="300" placeholder="继承"
                      style={inputStyle}
                      value={v.timeout ?? ''}
                      onChange={(e) => setField(r.id, 'timeout', e.target.value)}
                    />
                  </td>
                  <td>
                    <div className="cell-actions">
                      <button className="btn-sm btn-primary" onClick={() => saveRoom(r.id)}>应用</button>
                      {isCustom && <button className="btn-sm" onClick={() => resetRoom(r.id)}>恢复继承</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const inputStyle = {
  width: 86,
  padding: '6px 9px',
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 7,
  color: 'var(--text)',
  fontSize: 13,
};
