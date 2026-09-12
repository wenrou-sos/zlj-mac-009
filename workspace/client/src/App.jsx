import React, { useEffect, useState } from 'react';
import { StoreProvider, useStore } from './store.jsx';
import { api } from './api.js';
import Dashboard from './components/Dashboard.jsx';
import AlarmsPage from './components/AlarmsPage.jsx';
import TasksPage from './components/TasksPage.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import FacilitiesPage from './components/FacilitiesPage.jsx';
import RoomDetail from './components/RoomDetail.jsx';
import Toasts from './components/Toasts.jsx';

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const p = (n) => String(n).padStart(2, '0');
  return (
    <span className="clock">
      {now.getFullYear()}-{p(now.getMonth() + 1)}-{p(now.getDate())} {p(now.getHours())}:{p(now.getMinutes())}:{p(now.getSeconds())}
    </span>
  );
}

function Header({ page, setPage }) {
  const { connected, alarms, tasks, pushToast } = useStore();
  const activeCount = alarms.filter((a) => a.status !== 'recovered').length;
  const todoCount = tasks.filter((t) => ['pending', 'accepted', 'processing', 'done'].includes(t.status)).length;

  const randomFault = async () => {
    const types = ['cooling_fault', 'door_open', 'low_temp_fault', 'offline'];
    const type = types[Math.floor(Math.random() * types.length)];
    try {
      const r = await api.post('/sim/event', { type });
      pushToast('warning', `🎲 随机故障注入：${r.roomName}（${r.detail}）`);
    } catch (e) {
      pushToast('error', e.message);
    }
  };

  return (
    <header className="app-header">
      <div className="logo">
        <span className="snow">❄️</span>
        冷链温控管理系统
        <small>ColdChain TMS</small>
      </div>
      <nav className="nav">
        <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}>
          实时监控
        </button>
        <button className={page === 'alarms' ? 'active' : ''} onClick={() => setPage('alarms')}>
          告警中心
          {activeCount > 0 && <span className="badge-count">{activeCount}</span>}
        </button>
        <button className={page === 'tasks' ? 'active' : ''} onClick={() => setPage('tasks')}>
          维修工单
          {todoCount > 0 && <span className="badge-count">{todoCount}</span>}
        </button>
        <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
          心跳参数
        </button>
        <button className={page === 'facilities' ? 'active' : ''} onClick={() => setPage('facilities')}>
          冷库档案
        </button>
      </nav>
      <div className="header-right">
        <button className="btn-sm" onClick={randomFault} title="随机挑选一个冷库注入故障，用于演示告警与工单流程">
          🎲 随机故障演练
        </button>
        <span className={`conn`}>
          <i className={`dot ${connected ? '' : 'off'}`} />
          {connected ? '实时连接' : '断线重连中'}
        </span>
        <Clock />
      </div>
    </header>
  );
}

function Shell() {
  const [page, setPage] = useState('dashboard');
  const [historyRoom, setHistoryRoom] = useState(null);
  return (
    <>
      <Header page={page} setPage={setPage} />
      <main className="app-main">
        {page === 'dashboard' && <Dashboard onGoTasks={() => setPage('tasks')} />}
        {page === 'alarms' && <AlarmsPage />}
        {page === 'tasks' && <TasksPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'facilities' && (
          <FacilitiesPage onOpenHistory={(id) => setHistoryRoom(id)} />
        )}
        {historyRoom != null && (
          <RoomDetail roomId={historyRoom} onClose={() => setHistoryRoom(null)} />
        )}
      </main>
      <Toasts />
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
