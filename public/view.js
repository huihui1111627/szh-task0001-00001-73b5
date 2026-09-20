// 隧道区段场景渲染
import { fmtTick } from './api.js';

const LEVEL_EMOJI = ['Ⅰ', 'Ⅱ', 'Ⅲ'];

function smokeColor(s) {
  // 烟雾灰度
  const a = Math.min(0.92, s * 0.92);
  return `rgba(35,35,38,${a.toFixed(2)})`;
}
function tempColor(t) {
  if (t < 40) return null;
  const k = Math.min(1, (t - 40) / 120);
  const r = Math.round(255);
  const g = Math.round(211 - 130 * k);
  const b = Math.round(107 - 80 * k);
  return `rgba(${r},${g},${b},${(0.25 + k * 0.55).toFixed(2)})`;
}

export function renderTunnel(root, { frame, fire, fans, exits, selected, conflictRanges, onSelect }) {
  if (!frame) { root.innerHTML = ''; return; }
  const N = frame.smoke.length;
  root.innerHTML = '';
  const fanByIndex = new Map(fans.map(f => [f.index, f]));
  const exitByIndex = new Map(exits.map(e => [e.index, e]));
  const conflictSegs = new Set();
  (conflictRanges || []).forEach(([a, b]) => {
    for (let i = a; i <= b; i++) conflictSegs.add(i);
  });

  for (let i = 0; i < N; i++) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    if (selected === i) seg.classList.add('selected');
    if (frame.temp[i] >= 45 || frame.smoke[i] >= 0.55) seg.classList.add('danger-zone');
    if (frame.trapped.includes(i)) seg.classList.add('trapped');
    if (conflictSegs.has(i)) seg.title = '风机对吹影响区：气流停滞、烟雾易积聚';

    seg.style.background = smokeColor(frame.smoke[i]);
    const tc = tempColor(frame.temp[i]);
    if (tc) {
      const heat = document.createElement('div');
      heat.style.cssText = `position:absolute;inset:0;background:${tc};z-index:1`;
      seg.appendChild(heat);
    }

    if (fire.segment === i) {
      const f = document.createElement('div');
      f.className = 'fire'; f.textContent = '🚒';
      f.title = `起火点（火势 ${LEVEL_EMOJI[fire.level - 1]} 级）`;
      seg.appendChild(f);
    }
    const fan = fanByIndex.get(i);
    if (fan) {
      const e = document.createElement('div');
      e.className = 'fan-icon';
      e.textContent = fan.online ? (fan.dir > 0 ? '🌀→' : '←🌀') : '🌀✕';
      e.title = `${i}#射流风机 ${fan.online ? (fan.dir > 0 ? '向东' : '向西') : '停机'}`;
      seg.appendChild(e);
    }
    const exit = exitByIndex.get(i);
    if (exit) {
      const e = document.createElement('div');
      e.className = 'exit-icon';
      e.textContent = exit.open ? '🚪' : '🚧';
      e.title = `${exit.label} ${exit.open ? '可用' : '已封闭'}`;
      seg.appendChild(e);
    }
    if (frame.vehicles[i] > 0) {
      const c = document.createElement('div');
      c.className = 'cars'; c.textContent = `🚗${frame.vehicles[i]}`;
      seg.appendChild(c);
    }
    if (frame.people[i] >= 1) {
      const p = document.createElement('div');
      p.className = 'people-badge';
      p.textContent = `👤${Math.round(frame.people[i])}`;
      seg.appendChild(p);
    }
    const w = frame.wind[i];
    if (Math.abs(w) >= 0.25) {
      const a = document.createElement('div');
      a.className = 'wind-arrow';
      a.textContent = (w > 0 ? '→' : '←') + Math.abs(w).toFixed(1);
      seg.appendChild(a);
    }
    const tt = document.createElement('div');
    tt.className = 'temp-tag';
    tt.textContent = `${Math.round(frame.temp[i])}°`;
    tt.style.color = frame.temp[i] >= 45 ? '#ff8a6b' : '#9fb4d8';
    seg.appendChild(tt);

    seg.addEventListener('click', () => onSelect && onSelect(i));
    root.appendChild(seg);
  }
}

export function renderRuler(root, n, lenM) {
  root.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
  root.innerHTML = Array.from({ length: n }, (_, i) =>
    `<span>${(i * lenM / 1000).toFixed(1)}k</span>`).join('');
}
