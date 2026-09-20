// 决策时间轴 + 突发事件标记
import { fmtTick } from './api.js';

const MARK_STYLE = {
  setFan: { color: '#2f7cf6', icon: '🌀', label: '风机调整' },
  allFans: { color: '#2f7cf6', icon: '🌀', label: '批量风机' },
  toggleExit: { color: '#e5484d', icon: '🚪', label: '通道启闭' },
  extinguish: { color: '#3ecf8e', icon: '🧯', label: '灭火' },
  ignition: { color: '#f5a623', icon: '🔥', label: '起火' },
  casualty: { color: '#e5484d', icon: '☠', label: '伤亡' },
  trapped: { color: '#ff7a59', icon: '⚠', label: '人员被困' },
  complete: { color: '#3ecf8e', icon: '✓', label: '疏散完成' }
};

export function buildMarks(decisions, eventLog, maxTick) {
  const marks = [];
  for (const d of decisions) {
    marks.push({ tick: d.tick, kind: d.action, title: decisionTitle(d), style: MARK_STYLE[d.action] });
  }
  const seen = new Set();
  for (const e of eventLog) {
    if (!MARK_STYLE[e.type]) continue;
    const key = `${e.type}-${e.tick}-${e.segment ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    marks.push({ tick: e.tick, kind: e.type, title: eventTitle(e), style: MARK_STYLE[e.type] });
  }
  return { marks, maxTick: Math.max(maxTick, ...marks.map(m => m.tick), 1) };
}

function decisionTitle(d) {
  if (d.action === 'setFan') return `t=${fmtTick(d.tick)} ${d.index}#风机改为${d.dir > 0 ? '向东' : d.dir < 0 ? '向西' : '停机'}`;
  if (d.action === 'allFans') return `t=${fmtTick(d.tick)} 全部风机${d.dir > 0 ? '向东' : '向西'}`;
  if (d.action === 'toggleExit') return `t=${fmtTick(d.tick)} 通道 ${d.exitId} ${d.open ? '开启' : '封闭'}`;
  if (d.action === 'extinguish') return `t=${fmtTick(d.tick)} 执行灭火`;
  return '';
}
function eventTitle(e) {
  if (e.type === 'ignition') return `t=${fmtTick(e.tick)} 第${e.segment}区段起火（${['Ⅰ','Ⅱ','Ⅲ'][e.level - 1]}级）`;
  if (e.type === 'casualty') return `t=${fmtTick(e.tick)} 第${e.segment}区段 ${e.count} 人受高温危及（${e.reason}）`;
  if (e.type === 'trapped') return `t=${fmtTick(e.tick)} 第${e.segment}区段约 ${e.count} 人被困：${e.reason}`;
  if (e.type === 'complete') return `t=${fmtTick(e.tick)} ${e.reason}`;
  return '';
}

export function renderTimeline(root, { marks, maxTick, cursorTick, selectedTick, onPick }) {
  root.querySelectorAll('.tl-mark').forEach(n => n.remove());
  let prog = root.querySelector('.tl-progress');
  if (!prog) { prog = document.createElement('div'); prog.className = 'tl-progress'; root.appendChild(prog); }
  const pct = t => `${(t / maxTick * 100).toFixed(2)}%`;
  prog.style.width = pct(cursorTick || 0);
  const cursor = document.getElementById('tlCursor');
  cursor.style.left = pct(selectedTick ?? cursorTick ?? 0);
  for (const m of marks) {
    const el = document.createElement('div');
    el.className = 'tl-mark';
    el.style.left = pct(m.tick);
    el.style.background = m.style.color;
    el.title = m.title;
    el.textContent = '';
    el.addEventListener('click', ev => { ev.stopPropagation(); onPick && onPick(m.tick); });
    root.appendChild(el);
  }
}

export function renderTimelineLegend(root) {
  const used = ['ignition', 'setFan', 'toggleExit', 'trapped', 'casualty', 'complete'];
  root.innerHTML = used.map(k =>
    `<span><i style="background:${MARK_STYLE[k].color}"></i>${MARK_STYLE[k].icon} ${MARK_STYLE[k].label}</span>`
  ).join('');
}
