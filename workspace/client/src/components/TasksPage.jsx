import React from 'react';
import { useStore } from '../store.jsx';
import { api, fmtTime } from '../api.js';
import { ALARM_TYPE, LEVEL, TASK_STATUS } from '../labels.js';

const COLUMNS = [
  { key: 'pending', title: '🔔 待接单', statuses: ['pending'] },
  { key: 'doing', title: '🔧 维修处理中', statuses: ['accepted', 'processing'] },
  { key: 'verify', title: '🔍 待恢复确认', statuses: ['done'] },
  { key: 'closed', title: '✅ 已闭环', statuses: ['confirmed'] },
];

export default function TasksPage() {
  const { tasks, alarms, act } = useStore();

  const alarmOf = (id) => alarms.find((a) => a.id === id);

  const accept = async (t) => {
    const assignee = window.prompt('请输入接单维修人员姓名', '维修工');
    if (assignee == null) return;
    await act(() => api.post(`/tasks/${t.id}/accept`, { assignee }), `${assignee} 已接单`);
  };
  const start = (t) => act(() => api.post(`/tasks/${t.id}/start`), `任务 #${t.id} 已开始维修`);
  const done = async (t, restored) => {
    const note = window.prompt('请填写维修处理记录', restored ? '现场处置完成，设备恢复' : '已临时处置，待备件更换');
    if (note == null) return;
    await act(() => api.post(`/tasks/${t.id}/done`, { note, restored }),
      restored ? '维修完成，等待温度/通信恢复后闭环' : '维修完成（设备仍异常，暂不能闭环）');
  };
  const confirm = async (t) => {
    const note = window.prompt('恢复确认备注', '现场复核温度/通信正常');
    if (note == null) return;
    await act(() => api.post(`/tasks/${t.id}/confirm`, { note }), `任务 #${t.id} 已恢复确认并闭环`);
  };

  return (
    <div>
      <div className="page-title">
        <div>
          <h2>维修工单</h2>
          <div className="sub">
            告警自动生成工单 · 接单 → 开始维修 → 维修完成 → 恢复确认闭环（温度回区/传感器上线后方可确认）
          </div>
        </div>
      </div>

      <div className="kanban">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => col.statuses.includes(t.status));
          return (
            <div className="kcol" key={col.key}>
              <div className="kcol-head">
                {col.title}
                <span className="count">{items.length}</span>
              </div>
              {items.map((t) => {
                const liveAlarm = alarmOf(t.alarm_id);
                const level = liveAlarm?.level ?? t.alarm_level ?? t.priority;
                const alarmRecovered = (liveAlarm?.status || t.alarm_status) === 'recovered';
                return (
                  <div key={t.id} className={`tcard prio-${t.priority}`}>
                    <h4>
                      <span className="dim">#{t.id}</span> {t.title}
                    </h4>
                    <div className="meta">
                      <span className={`badge ${ALARM_TYPE[t.alarm_type]?.cls}`}>
                        {ALARM_TYPE[t.alarm_type]?.label}
                      </span>
                      <span className={`badge ${LEVEL[level]?.cls}`}>L{level} {LEVEL[level]?.label}</span>
                      <span className={`badge ${TASK_STATUS[t.status].cls}`}>{TASK_STATUS[t.status].label}</span>
                    </div>
                    <div className="desc">{t.description}</div>
                    {t.assignee && <div className="who">👷 处理人：{t.assignee}</div>}
                    {t.result_note && <div className="note">📝 {t.result_note}</div>}

                    <div className="acts">
                      {t.status === 'pending' && (
                        <button className="btn-sm btn-primary" onClick={() => accept(t)}>接单</button>
                      )}
                      {t.status === 'accepted' && (
                        <button className="btn-sm btn-primary" onClick={() => start(t)}>开始维修</button>
                      )}
                      {t.status === 'processing' && (
                        <>
                          <button className="btn-sm btn-primary" onClick={() => done(t, true)}>完成（已修复）</button>
                          <button className="btn-sm" onClick={() => done(t, false)}>完成（待备件）</button>
                        </>
                      )}
                      {t.status === 'done' && (
                        <>
                          <button
                            className="btn-sm btn-primary"
                            disabled={!alarmRecovered}
                            title={alarmRecovered ? '' : (t.alarm_type === 'sensor_offline' ? '传感器尚未上线' : '温度尚未回到正常区间')}
                            onClick={() => confirm(t)}
                          >
                            恢复确认
                          </button>
                          {!alarmRecovered && (
                            <span className="dim" style={{ alignSelf: 'center' }}>
                              {t.alarm_type === 'sensor_offline' ? '等待传感器上线…' : '等待温度回区…'}
                            </span>
                          )}
                        </>
                      )}
                      {t.status === 'confirmed' && (
                        <span className="dim">闭环于 {fmtTime(t.confirmed_at)}</span>
                      )}
                    </div>
                    <div className="dim" style={{ marginTop: 8 }}>
                      创建 {fmtTime(t.created_at)}
                    </div>
                  </div>
                );
              })}
              {items.length === 0 && <div className="dim" style={{ textAlign: 'center', padding: '20px 0' }}>—</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
