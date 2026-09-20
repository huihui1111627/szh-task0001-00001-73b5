// 多方案同步回放与指标对比
import { decodeFrame, fmtTick, TICK_MS } from './api.js';

let plans = [];
let playing = false;
let playPos = 0;
let timer = null;

function miniTunnel(frame, setup) {
  const html = frame.smoke.map((s, i) => {
    let bg = `rgba(35,35,38,${Math.min(0.92, s * 0.92).toFixed(2)})`;
    const t = frame.temp[i];
    let heat = '';
    if (t >= 40) {
      const k = Math.min(1, (t - 40) / 120);
      heat = `;box-shadow: inset 0 0 0 100px rgba(255,${Math.round(211 - 130*k)},${Math.round(107-80*k)},${(0.25+k*0.5).toFixed(2)})`;
    }
    const trapped = frame.trapped.includes(i);
    const fire = setup.fireSegment === i ? '🔥' : '';
    return `<div class="cseg" style="background:${bg}${heat}${trapped ? ';outline:2px solid #f5a623' : ''}">${fire}</div>`;
  }).join('');
  return `<div class="cmp-tunnel">${html}</div>`;
}

export async function openCompare(ids, api) {
  if (!window.__EXITS__) {
    const cfg = await api.config();
    window.__EXITS__ = cfg.exits;
  }
  const data = await api.compare(ids);
  plans = data.plans.map(p => ({ ...p, decoded: p.frames.map(decodeFrame) }));
  if (!plans.length) return;
  const modal = document.getElementById('compareModal');
  modal.classList.remove('hidden');
  playPos = 0;
  const maxLen = Math.max(...plans.map(p => p.decoded.length));
  const scrub = document.getElementById('cmpScrub');
  scrub.max = maxLen - 1;
  render(0);
}

function issuesAt(plan, frame) {
  const out = [];
  // 按当前帧风机方向实时检测对吹冲突
  const positions = [2, 6, 10, 14, 18, 22];
  const online = frame.fanDirs.map((d, k) => ({ index: positions[k], dir: d })).filter(f => f.dir !== 0);
  for (let a = 0; a < online.length; a++) {
    for (let b = a + 1; b < online.length; b++) {
      const fa = online[a], fb = online[b];
      if (fb.index - fa.index > 8) break;
      if (fa.index < fb.index && fa.dir === 1 && fb.dir === -1) {
        out.push({ type: 'fan_conflict', reason: `${fa.index}#与${fb.index}#风机对吹，第 ${fa.index}–${fb.index} 区段气流停滞、烟雾积聚` });
      }
    }
  }
  // 当前帧封闭的出口
  (plan.setup && window.__EXITS__ || []).forEach((e, k) => {
    if (frame.exitOpen[k] === 0) {
      out.push({ type: 'exit_unavailable', reason: `${e.label}不可用，附近人员需绕行至其他出口` });
    }
  });
  // 当前帧被困区段
  for (const seg of frame.trapped) {
    const count = Math.round(frame.people[seg] || 0);
    if (count >= 1) out.push({ type: 'trapped', reason: `第 ${seg} 区段约 ${count} 人被困，撤离路径被烟雾/高温阻断` });
  }
  return out;
}

function render(pos) {
  playPos = pos;
  const tracks = document.getElementById('compareTracks');
  const rows = plans.map(p => {
    const f = p.decoded[Math.min(pos, p.decoded.length - 1)];
    const issues = issuesAt(p, f);
    const issueHtml = issues.length ? issues.map(w =>
      `<div class="alert ${w.type}">${w.reason}</div>`).join('') : '<span style="color:var(--muted);font-size:12px">当前帧无冲突/不可用告警</span>';
    return `<div class="cmp-track">
      <div class="thead"><b>${p.name}</b>
        <span class="status-dot ${f.status}">${f.status === 'done' ? '已完成' : f.status === 'running' ? '运行中' : '暂停'}</span></div>
      ${miniTunnel(f, p.setup)}
      <div class="cmp-stat">
        <span>已撤离 <b>${f.evacuated}</b> 人</span>
        <span>被困/滞留 <b style="color:${f.trapped.length ? '#f5a623' : 'inherit'}">${f.trapped.reduce((a, i) => a + Math.round(f.people[i] || 0), 0)}</b> 人</span>
        <span>伤亡 <b style="color:${f.casualties ? '#e5484d' : 'inherit'}">${f.casualties}</b></span>
        <span>预计完成 <b>${p.etaTicks ? fmtTick(p.etaTicks) : '—'}</b></span>
      </div>
      <div class="compare-issues" style="margin-top:6px">${issueHtml}</div>
    </div>`;
  }).join('');
  tracks.innerHTML = rows;
  document.getElementById('cmpClock').textContent = fmtTick(pos);
  const scrub = document.getElementById('cmpScrub');
  scrub.value = pos;
  renderMetrics(pos);
}

function renderMetrics(pos) {
  // 汇总指标 + 最优行高亮（撤离最快、无伤亡、无被困）
  const data = plans.map(p => {
    const f = p.decoded[Math.min(pos, p.decoded.length - 1)];
    const total = f.people.reduce((a, b) => a + Math.round(b), 0);
    return {
      name: p.name,
      evacuated: f.evacuated,
      trapped: f.trapped.reduce((a, i) => a + Math.round(f.people[i] || 0), 0),
      casualties: f.casualties,
      remaining: total,
      completeTick: (() => {
        const doneIdx = p.decoded.findIndex(x => x.status === 'done');
        return doneIdx >= 0 ? doneIdx : null;
      })()
    };
  });
  const done = data.filter(d => d.completeTick !== null);
  const score = d => d.completeTick + d.casualties * 30;
  const bestScore = done.length ? Math.min(...done.map(score)) : null;
  const rows = data.map(d => {
    const best = d.completeTick !== null && score(d) === bestScore;
    return `<tr class="${best ? 'best' : ''}">
      <td>${d.name}${best ? ' 🏆' : ''}</td>
      <td>${d.evacuated}</td>
      <td style="color:${d.trapped ? '#f5a623' : 'inherit'}">${d.trapped}</td>
      <td style="color:${d.casualties ? '#e5484d' : 'inherit'}">${d.casualties}</td>
      <td>${d.remaining}</td>
      <td>${d.completeTick !== null ? fmtTick(d.completeTick) : '未完成'}</td>
    </tr>`;
  }).join('');
  document.getElementById('compareMetrics').innerHTML = `<table class="cmp-table">
    <thead><tr><th>方案</th><th>已撤离(人)</th><th>被困/滞留(人)</th><th>伤亡(人)</th><th>剩余(人)</th><th>实际完成时刻</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function initCompare() {
  document.getElementById('btnCloseCompare').addEventListener('click', () => {
    document.getElementById('compareModal').classList.add('hidden');
    stopPlay();
  });
  document.getElementById('cmpPlay').addEventListener('click', () => {
    if (plans.length) startPlay();
  });
  document.getElementById('cmpPause').addEventListener('click', stopPlay);
  document.getElementById('cmpScrub').addEventListener('input', e => {
    stopPlay(); render(Number(e.target.value));
  });
}

function startPlay() {
  if (playing) return;
  playing = true;
  timer = setInterval(() => {
    const maxLen = Math.max(...plans.map(p => p.decoded.length));
    if (playPos >= maxLen - 1) { stopPlay(); return; }
    render(playPos + 1);
  }, 400);
}
function stopPlay() { playing = false; if (timer) clearInterval(timer); timer = null; }
