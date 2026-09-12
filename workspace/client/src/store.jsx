import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { api } from './api.js';

const StoreContext = createContext(null);

let toastId = 0;

export function StoreProvider({ children }) {
  const [rooms, setRooms] = useState([]);
  const [alarms, setAlarms] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [stats, setStats] = useState(null);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState([]);
  const wsRef = useRef(null);
  const retryRef = useRef(null);

  const pushToast = useCallback((level, text) => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, level, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  // ---- 初始加载 ----
  const refreshAll = useCallback(async () => {
    try {
      const [ov, al, tk, st] = await Promise.all([
        api.get('/overview?minutes=60'),
        api.get('/alarms?all=1'),
        api.get('/tasks'),
        api.get('/stats'),
      ]);
      setRooms(ov);
      setAlarms(al);
      setTasks(tk);
      setStats(st);
    } catch (e) {
      pushToast('error', '数据加载失败：' + e.message);
    }
  }, [pushToast]);

  useEffect(() => {
    refreshAll();
    const timer = setInterval(async () => {
      try {
        const [ov, st] = await Promise.all([api.get('/overview?minutes=60'), api.get('/stats')]);
        setRooms(ov);
        setStats(st);
      } catch {
        /* 静默重试 */
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [refreshAll]);

  // ---- WebSocket 实时通道（断线自动重连） ----
  useEffect(() => {
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retryRef.current = setTimeout(connect, 3000);
      };
      ws.onmessage = (evt) => {
        const { type, payload } = JSON.parse(evt.data);
        switch (type) {
          case 'tick':
            if (payload?.rooms) setRooms((prev) => mergeRooms(prev, payload.rooms));
            break;
          case 'room:update':
            setRooms((prev) => mergeRooms(prev, [payload]));
            break;
          case 'alarm:new':
            setAlarms((a) => [payload.alarm, ...a]);
            setTasks((t) => [payload.task, ...t]);
            break;
          case 'alarm:update':
            setAlarms((a) => a.map((x) => (x.id === payload.id ? { ...x, ...payload } : x)));
            break;
          case 'alarm:escalate':
            setAlarms((a) =>
              a.map((x) =>
                x.id === payload.alarmId
                  ? { ...x, level: payload.level, escalated_at: Date.now() }
                  : x
              )
            );
            setTasks((t) =>
              t.map((x) =>
                x.alarm_id === payload.alarmId &&
                ['pending', 'accepted'].includes(x.status)
                  ? { ...x, priority: payload.level }
                  : x
              )
            );
            break;
          case 'alarm:recover':
            setAlarms((a) =>
              a.map((x) =>
                x.id === payload.alarmId
                  ? { ...x, status: 'recovered', recovered_at: Date.now() }
                  : x
              )
            );
            break;
          case 'task:update':
            setTasks((t) => {
              const exists = t.some((x) => x.id === payload.id);
              return exists
                ? t.map((x) => (x.id === payload.id ? { ...x, ...payload } : x))
                : [payload, ...t];
            });
            break;
          case 'toast':
            pushToast(payload.level || 'info', payload.text);
            break;
          default:
            break;
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, [pushToast]);

  // ---- 工单操作（失败时回滚并提示） ----
  const act = useCallback(
    async (fn, okText) => {
      try {
        const result = await fn();
        if (okText) pushToast('success', okText);
        return result;
      } catch (e) {
        pushToast('error', e.message);
        throw e;
      }
    },
    [pushToast]
  );

  const value = {
    rooms, alarms, tasks, stats, connected, toasts,
    pushToast, dismissToast, refreshAll, act,
  };
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

// 用 tick 快照覆盖房间动态字段，保留 60 分钟迷你曲线
function mergeRooms(prev, snapshot) {
  const byId = new Map(snapshot.map((r) => [r.id, r]));
  return prev.map((r) => {
    const s = byId.get(r.id);
    if (!s) return r;
    let spark = r.spark || [];
    if (s.current_temp != null) {
      const last = spark[spark.length - 1];
      if (!last || s.last_report_at > last.time) {
        spark = [...spark.slice(-720), { temp: s.current_temp, time: s.last_report_at }];
      }
    }
    return { ...r, ...s, spark };
  });
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}
