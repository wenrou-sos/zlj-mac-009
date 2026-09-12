import React from 'react';

// 轻量 SVG 迷你曲线：绿色区域为允许温区，曲线越界即异常
export default function Sparkline({ points = [], min, max, width = 234, height = 44 }) {
  if (points.length < 2) {
    return <div className="dim spark" style={{ height }}>暂无曲线数据</div>;
  }
  const temps = points.map((p) => p.temp);
  const lo = Math.min(...temps, min) - 1;
  const hi = Math.max(...temps, max) + 1;
  const pad = 2;
  const y = (t) => pad + (1 - (t - lo) / (hi - lo)) * (height - pad * 2);
  const x = (i) => (i / (points.length - 1)) * width;

  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.temp).toFixed(1)}`).join(' ');
  const bandY = y(max);
  const bandH = y(min) - bandY;
  const last = points[points.length - 1].temp;
  const out = last < min || last > max;

  return (
    <svg className="spark" width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <rect x="0" y={bandY} width={width} height={bandH} fill="rgba(34,197,94,0.10)" />
      <line x1="0" x2={width} y1={bandY} y2={bandY} stroke="rgba(248,113,113,0.55)" strokeWidth="0.8" strokeDasharray="3 3" />
      <line x1="0" x2={width} y1={bandY + bandH} y2={bandY + bandH} stroke="rgba(125,211,252,0.55)" strokeWidth="0.8" strokeDasharray="3 3" />
      <path d={d} fill="none" stroke={out ? '#f87171' : '#38bdf8'} strokeWidth="1.6" />
    </svg>
  );
}
