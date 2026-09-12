import React, { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.jsx';

const KINDS = ['冷冻库', '冷藏库', '深冷库', '速冻库', '恒温库'];

const empty = {
  code: '', name: '', zone: '', kind: '冷藏库',
  min_temp: 0, max_temp: 8, target_temp: 4,
  volume: 500, sensor_code: '',
};

export default function RoomForm({ room, onClose, onSaved }) {
  const { act } = useStore();
  const isEdit = !!room;
  const [f, setF] = useState(room
    ? {
        code: room.code, name: room.name, zone: room.zone, kind: room.kind,
        min_temp: room.min_temp, max_temp: room.max_temp, target_temp: room.target_temp,
        volume: room.volume, sensor_code: room.sensor_code,
      }
    : empty);
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const n = (v) => (v === '' || v === '-' ? v : Number(v));

  // 本地实时提示（最终以服务端校验为准）
  const mn = Number(f.min_temp), mx = Number(f.max_temp), tg = Number(f.target_temp);
  const hints = [];
  if (!(mn < mx)) hints.push('下限必须严格小于上限');
  if (!(tg >= mn && tg <= mx)) hints.push('目标温度需落在上下限之间');
  if (mn < -60 || mx > 40) hints.push('温度取值范围 -60℃ ~ 40℃');
  const vol = Number(f.volume);
  if (!(vol >= 10 && vol <= 100000)) hints.push('容积范围 10 ~ 100000 m³');

  const submit = async () => {
    setSaving(true);
    try {
      const payload = {
        ...f,
        min_temp: mn, max_temp: mx, target_temp: tg, volume: vol,
      };
      if (isEdit) {
        await act(() => api.put(`/rooms/${room.id}`, payload), `冷库「${f.name}」档案已更新`);
      } else {
        await act(() => api.post('/rooms', payload), `冷库「${f.name}」已建档`);
      }
      onSaved?.();
      onClose();
    } catch {
      /* 错误已由 act 弹 toast */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(620px, 100%)' }}>
        <div className="modal-head">
          <span style={{ fontSize: 20 }}>{isEdit ? '✏️' : '➕'}</span>
          <h3>{isEdit ? `编辑冷库档案 · ${room.code}` : '新增冷库建档'}</h3>
          <button className="btn-sm btn-ghost x" onClick={onClose}>✕ 关闭</button>
        </div>
        <div className="modal-body">
          {isEdit && (
            <div className="dim" style={{ marginBottom: 14 }}>
              修改温区上下限后，系统会立即用当前温度按新阈值复核活动告警：不再成立的告警自动恢复，新越限的立即告警。
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 18px' }}>
            <Field label="冷库编号 *" hint="全局唯一，如 E-01">
              <input style={inp} value={f.code} onChange={(e) => set('code', e.target.value)} placeholder="如 E-01" />
            </Field>
            <Field label="冷库名称 *">
              <input style={inp} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="如 海鲜暂养库" />
            </Field>
            <Field label="库区 *">
              <input style={inp} value={f.zone} onChange={(e) => set('zone', e.target.value)} placeholder="如 E区" />
            </Field>
            <Field label="冷库类型 *">
              <select style={inp} value={f.kind} onChange={(e) => set('kind', e.target.value)}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </Field>
            <Field label="传感器编号 *" hint="全局唯一，如 SEN-E01">
              <input style={inp} value={f.sensor_code} onChange={(e) => set('sensor_code', e.target.value)} placeholder="如 SEN-E01" />
            </Field>
            <Field label="库容 (m³)">
              <input style={inp} type="number" min="10" max="100000" value={f.volume}
                     onChange={(e) => set('volume', n(e.target.value))} />
            </Field>
            <Field label="温度下限 (℃)">
              <input style={inp} type="number" step="0.5" min="-60" max="40" value={f.min_temp}
                     onChange={(e) => set('min_temp', n(e.target.value))} />
            </Field>
            <Field label="温度上限 (℃)">
              <input style={inp} type="number" step="0.5" min="-60" max="40" value={f.max_temp}
                     onChange={(e) => set('max_temp', n(e.target.value))} />
            </Field>
            <Field label="目标温度 (℃)" hint="必须落在上下限之间" wide>
              <input style={inp} type="number" step="0.5" min="-60" max="40" value={f.target_temp}
                     onChange={(e) => set('target_temp', n(e.target.value))} />
            </Field>
          </div>

          <div style={{ marginTop: 14, minHeight: 20 }}>
            <div style={{ fontSize: 12.5, color: '#7dd3fc' }}>
              温区：[{mn}℃, {mx}℃]，目标 {tg}℃
            </div>
            {hints.map((h) => (
              <div key={h} style={{ fontSize: 12.5, color: '#fca5a5', marginTop: 4 }}>⛔ {h}</div>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving || hints.length > 0 || !f.code || !f.name || !f.zone || !f.sensor_code} onClick={submit}>
            {isEdit ? '保存修改' : '建档并接入监控'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, wide, children }) {
  return (
    <label style={{ display: 'block', gridColumn: wide ? '1 / -1' : undefined }}>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginBottom: 5 }}>
        {label}
        {hint && <span className="dim">（{hint}）</span>}
      </span>
      {children}
    </label>
  );
}

const inp = {
  width: '100%',
  padding: '8px 11px',
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text)',
  fontSize: 13.5,
};
