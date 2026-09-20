import { api, decodeFrame, fmtTick, toast } from './api.js';
import { renderTunnel, renderRuler } from './view.js';
import { buildMarks, renderTimeline, renderTimelineLegend } from './timeline.js';
import { openCompare, initCompare } from './compare.js';

const state = {
  config: null,
  setup: { fireSegment: 12, fireLevel: 2, trafficDensity: 0.6 },
  session: null,      // snapshot
  frames: [],         // 已解码帧
  eventLog: [],
  selectedSegment: null,
  selectedTick: null,
  compareIds: new Set(),
  evtSource: null,
  segHist: {},        // 区段历史指标（用于迷你趋势图）
  liveWarnings: []    // 最新一帧服务端告警（风机冲突/出口不可用）
};

const $ = id => document.getElementById(id);

async function init() {
  state.config = await api.config();
  $('fireSeg').max = state.config.segments - 1;
  bindSetup();
  bindControls();
  renderRuler($('tunnelRuler'), state.config.segments, state.config.segmentLengthM);
  renderTimelineLegend($('tlMarkers'));
  initCompare();
  await refreshPlanList(true);
}

function bindSetup() {
  $('fireSeg').addEventListener('input', e => {
    state.setup.fireSegment = Number(e.target.value);
    $('fireSegVal').textContent = e.target.value;
    $('fireMeterVal').textContent = `${e.target.value * 100}m`;
  });
  document.querySelectorAll('#fireLevel .chip').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#fireLevel .chip').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.setup.fireLevel = Number(b.dataset.v);
  }));
  $('density').addEventListener('input', e => {
    state.setup.trafficDensity = Number(e.target.value) / 100;
    $('densityVal').textContent = `${e.target.value}%`;
  });
  $('btnCreate').addEventListener('click', createSession);
}

async function createSession() {
  try {
    const snap = await api.createSession(state.setup, $('planName').value.trim());
    $('planName').value = '';
    toast('处置方案已创建，可启动推演');
    await selectSession(snap.id);
    await refreshPlanList();
  } catch (err) { toast(err.message, true); }
}

async function refreshPlanList(autoRecover = false) {
  const { sessions } = await api.listSessions();
  const root = $('planList');
  state.compareIds = new Set([...state.compareIds].filter(id => sessions.some(s => s.id === id)));
  if (!sessions.length) {
    root.innerHTML = '<div class="empty-note">暂无已保存方案</div>';
  } else {
    root.innerHTML = sessions.map(s => {
      const checked = state.compareIds.has(s.id) ? '☑' : '☐';
      const branch = s.branchFrom ? ' <span style="color:var(--muted)">(分支)</span>' : '';
      return `<div class="plan-item ${state.session?.id === s.id ? 'active' : ''}" data-id="${s.id}">
        <div>
          <div class="pname">${checked} ${s.name}${branch}</div>
          <div class="pmeta">${fmtTick(s.tick)} · 已撤离 ${s.evacuated} · 滞留 ${s.remainingPeople} · 伤亡 ${s.casualties}</div>
        </div>
        <div><span class="status-dot ${s.status}">${s.status === 'running' ? '运行' : s.status === 'done' ? '完成' : s.status === 'ready' ? '就绪' : '暂停'}</span>
        <span class="del" data-del="${s.id}">🗑</span></div>
      </div>`;
    }).join('');
    root.querySelectorAll('.plan-item').forEach(el => el.addEventListener('click', e => {
      if (e.target.dataset.del) {
        e.stopPropagation();
        api.remove(e.target.dataset.del).then(() => {
          if (state.session?.id === e.target.dataset.del) resetView();
          refreshPlanList();
        });
        return;
      }
      // Shift/点击勾选加入对比；普通点击切换当前方案
      if (e.shiftKey || e.target.closest('.pname')) {
        const id = el.dataset.id;
        state.compareIds.has(id) ? state.compareIds.delete(id) : state.compareIds.add(id);
        refreshPlanList();
      } else {
        selectSession(el.dataset.id);
      }
    }));
  }

  // 刷新/服务重启后自动恢复：恢复一个未完成方案
  if (autoRecover && sessions.length) {
    const unfinished = sessions.find(s => s.status === 'paused' && s.tick > 0)
      || sessions.find(s => s.status === 'ready');
    if (unfinished) {
      $('recoverBanner').classList.remove('hidden');
      await selectSession(unfinished.id);
      if (unfinished.tick > 0) toast(`已恢复「${unfinished.name}」，断点 ${fmtTick(unfinished.tick)}，可继续推演`);
    }
  }
}

function resetView() {
  if (state.evtSource) { state.evtSource.close(); state.evtSource = null; }
  state.session = null; state.frames = []; state.eventLog = [];
  $('sessionTitle').textContent = '尚未创建推演';
  $('sessionMeta').textContent = '设置参数后点击「新建处置方案」';
  $('tunnel').innerHTML = '';
  $('kpis').innerHTML = '';
  $('alerts').innerHTML = '<div class="empty-note">暂无告警</div>';
  $('fanList').innerHTML = '';
  $('exitList').innerHTML = '';
}

async function selectSession(id) {
  if (state.evtSource) { state.evtSource.close(); state.evtSource = null; }
  const snap = await api.snapshot(id);
  state.session = snap;
  state.selectedSegment = null;
  state.selectedTick = null;
  state.segHist = {};
  state.liveWarnings = snap.warnings || [];
  const data = await api.frames(id);
  state.frames = data.frames.map(decodeFrame);
  state.eventLog = snap.recentEvents ? snap.recentEvents : [];
  // 拉取完整事件日志（从 snapshot 只拿了最近 30 条）——通过 compare 接口补全
  try {
    const cmp = await api.compare([id]);
    if (cmp.plans[0]) state.eventLog = cmp.plans[0].eventLog || state.eventLog;
  } catch {}
  renderSessionControls(snap);
  renderAll();
  connectStream(id);
  refreshPlanList();
}

function connectStream(id) {
  const es = new EventSource(`/api/sessions/${id}/stream`);
  state.evtSource = es;
  es.onmessage = async ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') {
      state.session = msg.snapshot;
      renderSessionControls(msg.snapshot);
      // 重连或服务重启后，用服务端帧序列校准本地（中断恢复）
      try {
        const data = await api.frames(msg.snapshot.id);
        state.frames = data.frames.map(decodeFrame);
      } catch {}
      renderAll();
    } else if (msg.type === 'tick') {
      state.frames.push(decodeFrame(msg.frame));
      state.eventLog.push(...(msg.events || []));
      if (msg.warnings) state.liveWarnings = msg.warnings;
      state.session = applyFrameToSession(state.session, msg.frame, state.liveWarnings);
      renderSessionControls(state.session);
      renderAll(msg.warnings, msg.events);
    } else if (msg.type === 'decision') {
      state.frames[state.frames.length - 1] = decodeFrame(msg.frame);
      state.session.fans = mergeFans(state.session.fans, msg.decision);
      state.session.exits = mergeExits(state.session.exits, msg.decision);
      state.liveWarnings = msg.warnings || [];
      state.session.warnings = state.liveWarnings;
      renderSessionControls(state.session);
      renderAll(msg.warnings);
      toast(`决策已记录到时间轴：${decisionLabel(msg.decision)}`);
    } else if (msg.type === 'status') {
      if (state.session) state.session.status = msg.status;
      renderSessionControls(state.session);
      if (msg.status === 'done') { refreshPlanList(); toast('推演结束'); }
    } else if (msg.type === 'seek') {
      selectSession(state.session.id);
    } else if (msg.type === 'error') {
      toast('操作失败，已回滚到最近有效状态：' + msg.message, true);
    }
  };
  es.onerror = () => { /* SSE 断开自动重连；后端重启后 snapshot 事件会重新同步 */ };
}

function applyFrameToSession(snap, rawFrame, warnings) {
  const f = decodeFrame(rawFrame);
  return {
    ...snap,
    status: f.status,
    tick: f.tick,
    evacuated: f.evacuated,
    casualties: f.casualties,
    remainingPeople: Math.round(f.people.reduce((a, b) => a + b, 0)),
    affectedPeople: Math.round(f.people.reduce((a, b) => a + b, 0) + f.casualties),
    warnings: warnings || snap.warnings,
    fans: snap.fans.map((fan, k) => {
      const code = f.fanDirs[k];
      return code === 0 ? { ...fan, dir: 0, online: false }
        : { ...fan, dir: code, online: true };
    }),
    etaTicks: snap.etaTicks
  };
}
function mergeExits(exits, decision) {
  if (decision.action === 'toggleExit') {
    return exits.map(e => e.id === decision.exitId ? { ...e, open: decision.open } : e);
  }
  return exits;
}
function mergeFans(fans, decision) {
  if (decision.action === 'setFan') {
    return fans.map(f => f.index === decision.index
      ? { ...f, dir: decision.dir, online: decision.dir !== 0 } : f);
  }
  if (decision.action === 'allFans') {
    return fans.map(f => ({ ...f, dir: decision.dir, online: true }));
  }
  return fans;
}
function decisionLabel(d) {
  if (d.action === 'setFan') return `${d.index}#风机${d.dir > 0 ? '向东' : d.dir < 0 ? '向西' : '停机'}`;
  if (d.action === 'allFans') return `全部风机${d.dir > 0 ? '向东' : '向西'}`;
  if (d.action === 'toggleExit') return `通道 ${d.exitId} ${d.open ? '开启' : '封闭'}`;
  if (d.action === 'extinguish') return '执行灭火';
  return d.action;
}

function renderSessionControls(snap) {
  $('sessionTitle').textContent = snap.name;
  $('sessionMeta').innerHTML =
    `起火点：第${snap.fire.segment}区段 · 火势 ${'ⅠⅡⅢ'[snap.fire.level - 1]} 级 · ` +
    `交通密度 ${Math.round(snap.setup.trafficDensity * 100)}% · 状态：` +
    `<span class="status-dot ${snap.status}">${snap.status === 'running' ? '运行中' : snap.status === 'done' ? '已完成' : snap.status === 'ready' ? '就绪' : '已暂停'}</span>` +
    (snap.branchFrom ? ' · 由其他方案分叉' : '');

  // 风机按钮组
  $('fanList').innerHTML = snap.fans.map(f => `
    <div class="fan-row">
      <span>🌀 ${f.index}# 风机</span>
      <div class="fan-dir" data-fan="${f.index}">
        <button data-dir="-1" class="${f.online && f.dir === -1 ? 'on' : ''}">← 西</button>
        <button data-dir="0" class="${!f.online ? 'on' : ''}">停</button>
        <button data-dir="1" class="${f.online && f.dir === 1 ? 'on' : ''}">东 →</button>
      </div>
    </div>`).join('');
  $('fanList').querySelectorAll('.fan-dir').forEach(g => g.addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    doDecision('setFan', { index: Number(g.dataset.fan), dir: Number(btn.dataset.dir) });
  }));
  $('fansEast').onclick = () => doDecision('allFans', { dir: 1 });
  $('fansWest').onclick = () => doDecision('allFans', { dir: -1 });

  // 出口列表
  $('exitList').innerHTML = snap.exits.map(ex => `
    <div class="exit-row">
      <span>🚪 ${ex.label} <span style="color:var(--muted)">（第${ex.index}段）</span></span>
      <span class="sw ${ex.open ? '' : 'off'}" data-exit="${ex.id}" data-open="${ex.open ? 0 : 1}"
        style="cursor:pointer" title="点击启闭"></span>
    </div>`).join('');
  $('exitList').querySelectorAll('[data-exit]').forEach(el => el.addEventListener('click', () =>
    doDecision('toggleExit', { exitId: el.dataset.exit, open: el.dataset.open === '1' })));
}

async function doDecision(action, params) {
  if (!state.session) return toast('请先创建或选择方案', true);
  try {
    const res = await api.decide(state.session.id, action, params);
    if (res.warnings?.length) {
      toast(`决策已生效，同时检测到 ${res.warnings.length} 项风险（见右侧告警）`);
    }
  } catch (err) { toast(err.message + '（已回滚）', true, 4000); }
}

function currentFrame() {
  const idx = state.selectedTick ?? state.frames.length - 1;
  return { frame: state.frames[Math.max(0, idx)], idx };
}

function renderAll(newWarnings, newEvents) {
  const snap = state.session;
  if (!snap || !state.frames.length) return;
  const { frame, idx } = currentFrame();

  const conflictRanges = (snap.warnings || []).filter(w => w.type === 'fan_conflict').map(w => w.range);
  renderTunnel($('tunnel'), {
    frame, fire: snap.fire, fans: snap.fans, exits: snap.exits,
    selected: state.selectedSegment, conflictRanges,
    onSelect: i => { state.selectedSegment = i; renderAll(); }
  });

  $('clock').textContent = fmtTick(frame.tick);
  const remaining = Math.round(frame.people.reduce((a, b) => a + b, 0));
  $('kpis').innerHTML = `
    <div class="kpi good"><b>${frame.evacuated}</b><span class="lbl">已撤离(人)</span></div>
    <div class="kpi ${remaining ? '' : 'good'}"><b>${remaining}</b><span class="lbl">滞留(人)</span></div>
    <div class="kpi ${frame.trapped.length ? 'bad' : ''}"><b>${frame.trapped.reduce((a, i) => a + Math.round(frame.people[i] || 0), 0)}</b><span class="lbl">被困(人)</span></div>
    <div class="kpi ${frame.casualties ? 'bad' : ''}"><b>${frame.casualties}</b><span class="lbl">受危及(人)</span></div>
    <div class="kpi"><b>${snap.etaTicks ? fmtTick(snap.etaTicks) : '—'}</b><span class="lbl">预计完成</span></div>`;

  renderAlerts(newWarnings, newEvents);
  renderSegmentDetail(frame, idx);
  renderTl(frame);
}

function renderAlerts(newWarnings, newEvents) {
  const root = $('alerts');
  const items = [];
  for (const w of state.session.warnings || []) {
    items.push({ key: w.type + JSON.stringify(w.range || w.exit), cls: w.type, time: '', text: w.reason,
      impact: w.type === 'fan_conflict'
        ? `影响范围：第 ${w.range[0]}–${w.range[1]} 区段（气流停滞、烟雾积聚，能见度加速下降）`
        : `影响范围：第 ${w.segment} 区段周边，人员疏散路径被迫延长` });
  }
  const recent = [...(state.eventLog || [])].reverse().slice(0, 12);
  for (const e of recent) {
    if (!['trapped', 'casualty', 'ignition', 'complete'].includes(e.type)) continue;
    if (e.type === 'casualty' && (e.count ?? 1) < 0.5) continue;
    if (e.type === 'trapped' && (e.count ?? 1) < 0.5) continue;
    items.push({ key: `${e.type}-${e.tick}-${e.segment}`, cls: e.type,
      time: fmtTick(e.tick),
      text: e.type === 'trapped' ? `第${e.segment}区段约 ${e.count} 人被困：${e.reason}`
        : e.type === 'casualty' ? `第${e.segment}区段 ${e.count} 人受危及（${e.reason}）`
        : e.type === 'ignition' ? `第${e.segment}区段起火，火势 ${'ⅠⅡⅢ'[e.level - 1]} 级`
        : e.reason,
      impact: e.type === 'trapped' ? `影响范围：第${e.segment}区段，需调整风机方向或开辟通道` : '' });
  }
  if (!items.length) { root.innerHTML = '<div class="empty-note">暂无告警</div>'; return; }
  root.innerHTML = items.slice(0, 20).map(a =>
    `<div class="alert ${a.cls}"><span class="at">${a.time ? '🕒 ' + a.time : '实时'}</span>${a.text}` +
    (a.impact ? `<div class="impact">${a.impact}</div>` : '') + `</div>`).join('');
}

function renderSegmentDetail(frame, idx) {
  const root = $('segmentDetail');
  if (state.selectedSegment === null) {
    root.className = 'seg-detail empty';
    root.textContent = '点击隧道任一区段查看实时变化与受影响人员';
    return;
  }
  const i = state.selectedSegment;
  root.className = 'seg-detail';
  const s = frame.smoke[i], t = frame.temp[i], v = frame.visibility[i];
  const people = Math.round(frame.people[i] || 0);
  const cars = frame.vehicles[i] || 0;
  const trapped = frame.trapped.includes(i);
  const exitInfo = state.session.exits.find(e => e.index === i);
  const fanInfo = state.session.fans.find(f => f.index === i);
  let risk = '安全';
  if (t >= 60 || s >= 0.55) risk = '阻断/致命';
  else if (t >= 45 || v <= 8) risk = '危险';
  else if (s >= 0.2 || t >= 35) risk = '警戒';

  // 收集该区段的历史指标用于趋势 sparkline
  if (!state.segHist[i] || state.segHist[i]._upto !== idx) {
    const hist = state.frames.slice(Math.max(0, idx - 60), idx + 1);
    state.segHist[i] = { _upto: idx, hist };
  }
  const hist = state.segHist[i].hist;
  const smokePath = sparkPath(hist.map(f => f.smoke[i]), 1);
  const tempPath = sparkPath(hist.map(f => f.temp[i]), 300);

  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <b>第 ${i} 区段（${(i * 100)}–${(i + 1) * 100}m）</b>
      <span class="status-dot ${risk === '安全' ? 'done' : risk === '警戒' ? 'paused' : 'running'}"
        style="background:${risk === '阻断/致命' ? 'rgba(229,72,77,.3)' : ''};color:${risk === '阻断/致命' ? '#ff8d90' : ''}">${risk}${trapped ? ' · 有被困' : ''}</span>
    </div>
    <div class="metric-grid">
      <div class="m"><b>${(s * 100).toFixed(0)}%</b><span>烟雾浓度</span></div>
      <div class="m"><b>${Math.round(t)}℃</b><span>温度</span></div>
      <div class="m"><b>${v.toFixed(1)}m</b><span>能见度</span></div>
      <div class="m"><b>${Math.abs(frame.wind[i]).toFixed(1)}m/s ${frame.wind[i] > 0 ? '→' : frame.wind[i] < 0 ? '←' : ''}</b><span>风速/风向</span></div>
      <div class="m"><b>${people}</b><span>当前人员</span></div>
      <div class="m"><b>${cars}</b><span>滞留车辆</span></div>
    </div>
    <div>
      <div style="font-size:12px;color:var(--muted)">烟雾浓度趋势（近 2 分钟）</div>
      <svg class="spark" viewBox="0 0 200 46" preserveAspectRatio="none">
        <path d="${smokePath}" fill="rgba(140,140,140,.3)" stroke="#bbb" stroke-width="1.5"/></svg>
      <div style="font-size:12px;color:var(--muted)">温度趋势（近 2 分钟）</div>
      <svg class="spark" viewBox="0 0 200 46" preserveAspectRatio="none">
        <path d="${tempPath}" fill="rgba(245,120,60,.25)" stroke="#ff7a3c" stroke-width="1.5"/></svg>
    </div>
    <div style="font-size:12px;margin-top:8px;color:var(--muted)">
      ${fanInfo ? `🌀 本区有 ${i}#射流风机（${fanInfo.online ? (fanInfo.dir > 0 ? '向东送风' : '向西送风') : '停机'}）<br>` : ''}
      ${exitInfo ? `🚪 ${exitInfo.label}${exitInfo.open ? '可用' : '已封闭'}<br>` : ''}
      受影响人员（含已撤离与受危及）：参见 KPI 与被困标记
    </div>`;
}

function sparkPath(values, maxV) {
  if (!values.length) return '';
  const W = 200, H = 46;
  const step = W / Math.max(values.length - 1, 1);
  let d = values.map((v, k) =>
    `${k === 0 ? 'M' : 'L'}${(k * step).toFixed(1)},${(H - Math.min(1, v / maxV) * (H - 4) - 2).toFixed(1)}`).join(' ');
  d += ` L${W},${H} L0,${H} Z`;
  return d;
}

function renderTl(frame) {
  const { marks, maxTick } = buildMarks(
    state.session.decisions || [], state.eventLog || [],
    Math.max(frame.tick + 5, 60));
  const selected = state.selectedTick ?? frame.tick;
  renderTimeline($('timeline'), {
    marks, maxTick, cursorTick: frame.tick, selectedTick: selected,
    onPick: tick => { state.selectedTick = tick; renderAll(); }
  });
  $('timeline').onclick = e => {
    if (e.target.classList.contains('tl-mark')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const tick = Math.round((e.clientX - rect.left) / rect.width * maxTick);
    state.selectedTick = Math.max(0, Math.min(frame.tick, tick));
    renderAll();
  };
}

function bindControls() {
  const ctrl = async action => {
    if (!state.session) return toast('请先创建方案', true);
    try {
      const res = await api.control(state.session.id, action);
      if (res.error) return toast(res.error, true);
      if (action === 'step') {
        // 单步结果经 SSE 推送；此处兜底刷新
      }
    } catch (err) { toast(err.message, true); }
  };
  $('btnStart').onclick = () => ctrl('start');
  $('btnPause').onclick = () => ctrl('pause');
  $('btnStep').onclick = () => ctrl('step');

  $('btnSeek').onclick = async () => {
    const tick = state.selectedTick;
    if (tick === null) return toast('请先在时间轴上选择节点', true);
    if (!confirm(`回到 ${fmtTick(tick)} 将截断该节点之后的时间轴（后续可重新推演）。确定？`)) return;
    try {
      await api.seek(state.session.id, tick);
      toast(`已回到 ${fmtTick(tick)}，此后的操作将形成新的推演路径`);
    } catch (err) { toast(err.message, true); }
  };

  $('btnBranch').onclick = async () => {
    const tick = state.selectedTick;
    if (tick === null) return toast('请先在时间轴上选择节点', true);
    const name = prompt('新方案名称：', `${state.session.name} @${fmtTick(tick)}`);
    if (name === null) return;
    try {
      const snap = await api.branch(state.session.id, tick, name);
      toast('已从该节点分叉出新方案，原方案完整保留');
      await selectSession(snap.id);
      await refreshPlanList();
    } catch (err) { toast(err.message, true); }
  };

  $('btnCompare').onclick = async () => {
    let ids = [...state.compareIds];
    if (ids.length < 2) {
      const { sessions } = await api.listSessions();
      ids = sessions.slice(0, 3).map(s => s.id);
      if (ids.length < 2) return toast('至少需要两个方案才能对比（可先从时间轴分叉）', true, 3600);
    }
    try { await openCompare(ids, api); } catch (err) { toast(err.message, true); }
  };
}

init().catch(err => toast('初始化失败：' + err.message, true, 6000));
