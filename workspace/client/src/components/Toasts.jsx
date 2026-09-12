import React from 'react';
import { useStore } from '../store.jsx';

const ICON = { error: '⛔', warning: '⚠️', success: '✅', info: 'ℹ️' };

export default function Toasts() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <span className="tic">{ICON[t.level] || 'ℹ️'}</span>
          <span>{t.text}</span>
          <span className="close" onClick={() => dismissToast(t.id)}>✕</span>
        </div>
      ))}
    </div>
  );
}
