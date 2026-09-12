import React, { useState } from 'react';
import { useStore } from '../store.jsx';
import { api, ago } from '../api.js';
import { tempColorCls } from '../labels.js';
import RoomForm from './RoomForm.jsx';

export default function FacilitiesPage({ onOpenHistory }) {
  const { rooms, alarms, act, pushToast, refreshAll } = useStore();
  const [editing, setEditing] = useState(null); // null | false | room
  const [confirmDelete, setConfirmDelete] = useState(null);

  const hasActiveAlarm = (id) =>
    alarms.some((a) => a.room_id === id && a.status !== 'recovered');

  const doDelete = async () => {
    const room = confirmDelete;
    try {
      await act(() => api.del(`/rooms/${room.id}`), `冷库「${room.name}」已删除`);
      setConfirmDelete(null);
    } catch {
      /* toast 已提示 */
    }
  };

  const saved = async () => {
    await refreshAll();
    pushToast('info', '档案已同步，告警判定与曲线温区已使用新参数');
  };

  return (
    <div>
      <div className="page-title">
        <div>
          <h2>冷库档案与温区维护</h2>
          <div className="sub">
            新增探头 / 改存货类别 / 季节调温可直接在此维护；温区修改即时作用于告警判定与历史曲线的正常温区，
            无需重启或重建数据库，历史读数、告警与工单全部保留。
          </div>
        </div>
        <button className="btn-primary" onClick={() => setEditing(false)}>➕ 新增冷库</button>
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th style={{ width: 80 }}>编号</th>
              <th>名称</th>
              <th style={{ width: 80 }}>库区</th>
              <th style={{ width: 90 }}>类型</th>
              <th style={{ width: 120 }}>温区 (℃)</th>
              <th style={{ width: 90 }}>目标 (℃)</th>
              <th style={{ width: 90 }}>当前 (℃)</th>
              <th style={{ width: 90 }}>库容</th>
              <th style={{ width: 130 }}>传感器 / 上报</th>
              <th style={{ width: 90 }}>状态</th>
              <th style={{ width: 180 }}></th>
            </tr>
          </thead>
          <tbody>
            {rooms.map((r) => {
              const activeAlarm = hasActiveAlarm(r.id);
              const noData = r.current_temp == null;
              return (
                <tr key={r.id}>
                  <td className="mono">{r.code}</td>
                  <td>{r.name}</td>
                  <td>{r.zone}</td>
                  <td>{r.kind}</td>
                  <td className="mono">{r.min_temp} ~ {r.max_temp}</td>
                  <td className="mono">{r.target_temp}</td>
                  <td className={`mono ${noData ? '' : tempColorCls(r)}`}>
                    {noData ? <span className="dim">待上报</span> : r.current_temp.toFixed(1)}
                  </td>
                  <td className="mono">{r.volume}m³</td>
                  <td>
                    <div className="mono" style={{ fontSize: 12 }}>{r.sensor_code}</div>
                    <div className="dim" style={{ fontSize: 11 }}>{ago(r.last_report_at)}</div>
                  </td>
                  <td>
                    {r.status === 'offline'
                      ? <span className="badge gray">离线</span>
                      : noData
                        ? <span className="badge cyan">待上报</span>
                        : activeAlarm
                          ? <span className="badge red">告警中</span>
                          : <span className="badge green">正常</span>}
                  </td>
                  <td>
                    <div className="cell-actions">
                      {onOpenHistory && (
                        <button className="btn-sm" onClick={() => onOpenHistory(r.id)}>曲线</button>
                      )}
                      <button className="btn-sm btn-primary" onClick={() => setEditing(r)}>编辑</button>
                      <button className="btn-sm btn-danger" onClick={() => setConfirmDelete(r)}>删除</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing !== null && (
        <RoomForm
          room={editing || undefined}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}

      {confirmDelete && (
        <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDelete(null)}>
          <div className="modal" style={{ width: 'min(460px, 100%)' }}>
            <div className="modal-head"><h3>确认删除冷库</h3></div>
            <div className="modal-body">
              确定删除 <b>{confirmDelete.name}（{confirmDelete.code}）</b> 吗？
              <div style={{ marginTop: 10 }} className="dim">
                该库的全部历史读数、告警与维修工单将一并级联删除，操作不可恢复。
              </div>
            </div>
            <div className="modal-foot">
              <button onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="btn-danger" onClick={doDelete}>确认删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
