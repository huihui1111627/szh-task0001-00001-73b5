/* 主控: 状态编排 / 自动推演 / 回滚 / 中断恢复 / 时间轴交互 */
(function () {
  const C = window.CONSTANTS;
  const E = window.SimEngine;

  const state = {
    sim: null,
    running: false,
    runTimer: null,
    speed: 2,
    fireLevel: 2,
    selectedSeg: null,
    hoverSeg: null,
    selectedTick: null,
    plans: [],
    chosenPlans: new Set(),
    dirty: false,
    lastSave: 0,
    restored: false
  };

  const $ = id => document.getElementById(id);

  // ---------- 初始化 ----------
  async function init() {
    bindControls();
    await restoreSession();
    if (!state.sim) newSim();
    renderAll();
    refreshPlans();
    setInterval(autosave, 2000);
    window.addEventListener('beforeunload', () => { if (state.dirty) persist(true); });
  }

  function newSim(snapshotSim) {
    stopLoop();
    if (snapshotSim) {
      state.sim = snapshotSim;
    } else {
      state.sim = E.createSim({ density: $('densitySel').value });
    }
    state.selectedSeg = null;
    state.selectedTick = null;
    syncControlsFromSim();
    markDirty();
  }

  async function restoreSession() {
    const saved = await window.Api.loadSession();
    if (saved && saved.sim && saved.sim.version === 1) {
      try {
        newSim(saved.sim);
        state.restored = true;
        const ago = Math.round((Date.now() - (saved.savedAt || 0)) / 1000);
        toast('已恢复未完成推演 (上次保存于 ' + ago + ' 秒前, t=' +
          E.formatClock(saved.sim.tick * C.TICK_SECONDS) + ')', 'ok', 5000);
      } catch (e) {
        toast('会话恢复失败, 已创建新推演');
        newSim();
      }
    }
  }

  // ---------- 命令封装 (失败回滚到最近有效状态) ----------
  function command(cmd, opts) {
    opts = opts || {};
    const backup = E.clone(state.sim);
    const r = E.apply(state.sim, cmd);
    if (!r.ok) {
      state.sim = backup;                 // 回到最近一次有效状态
      toast('操作被拒绝: ' + r.error);
      renderAll();
      return false;
    }
    if (!r.noop) markDirty();
    renderAll();
    return true;
  }

  // ---------- 自动推演循环 ----------
  function startLoop() {
    if (!state.sim.fire) { toast('请先设置起火位置并初始化推演'); return false; }
    if (!command({ type: 'start' })) return false;
    state.running = true;
    scheduleTick();
    renderAll();
    return true;
  }

  function scheduleTick() {
    clearTimeout(state.runTimer);
    const interval = Math.max(90, 1000 / state.speed);
    state.runTimer = setTimeout(function tick() {
      if (!state.running || state.sim.status !== C.STATUS.RUNNING) {
        state.running = false; renderAll(); return;
      }
      const r = E.step(state.sim);
      if (!r.ok) { state.running = false; toast(r.error); renderAll(); return; }
      markDirty();
      renderAll();
      if (state.sim.status === C.STATUS.FINISHED) {
        state.running = false;
        toast('推演结束: ' + state.sim.totals.evacuated + ' 人撤离, ' +
          state.sim.totals.trapped + ' 人被困', 'ok', 6000);
        window.Api.clearSession();
        return;
      }
      scheduleTick();
    }, interval);
  }

  function pauseLoop() {
    state.running = false;
    clearTimeout(state.runTimer);
    command({ type: 'pause' });
  }

  function stopLoop() {
    state.running = false;
    clearTimeout(state.runTimer);
  }

  function singleStep() {
    stopLoop();
    if (command({ type: 'step' })) markDirty();
  }

  // ---------- 持久化 ----------
  function markDirty() { state.dirty = true; }

  function autosave() {
    if (!state.dirty) return;
    if (Date.now() - state.lastSave < 1500) return;
    persist();
  }

  function persist(sync) {
    state.lastSave = Date.now();
    state.dirty = false;
    if (state.sim.status === C.STATUS.FINISHED) { window.Api.clearSession(); return; }
    const p = window.Api.saveSession(state.sim);
    if (sync) { /* fire-and-forget, localStorage 同步兜底已在 Api 内 */ }
    return p;
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg, kind, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.className = kind === 'ok' ? 'toast ok' : 'toast';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3200);
  }

  window.App = { toast: toast };

  // ---------- 控件绑定 ----------
  function bindControls() {
    // 场景设置
    $('fireSeg').oninput = e => { $('fireSegVal').textContent = e.target.value; };
    $('fireLevel').onclick = e => {
      const btn = e.target.closest('.seg-btn'); if (!btn) return;
      $('fireLevel').querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      state.fireLevel = +btn.dataset.level;
    };
    $('densitySel').onchange = e => {
      if (state.sim && state.sim.fire) {
        e.target.value = state.sim.density;
        toast('起火后不能调整交通密度, 请重置后再设置');
        return;
      }
      command({ type: 'set_density', density: e.target.value });
    };
    $('igniteBtn').onclick = () => {
      const seg = +$('fireSeg').value;
      command({ type: 'set_fire', seg: seg, level: state.fireLevel });
      state.selectedSeg = seg;
      toast('火灾已在 ' + seg + '# 区段触发 (等级 ' + state.fireLevel + '), 点击启动开始推演', 'ok');
    };

    // 推演控制
    $('startBtn').onclick = startLoop;
    $('pauseBtn').onclick = pauseLoop;
    $('stepBtn').onclick = singleStep;
    $('resetBtn').onclick = () => {
      stopLoop();
      window.Api.clearSession();
      state.sim = E.createSim({ density: $('densitySel').value });
      state.selectedSeg = null; state.selectedTick = null;
      markDirty(); renderAll();
      toast('已重置为新推演');
    };
    $('speedGroup').onclick = e => {
      const btn = e.target.closest('.seg-btn'); if (!btn) return;
      $('speedGroup').querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      state.speed = +btn.dataset.speed;
    };

    // 隧道交互
    const canvas = $('tunnelCanvas');
    canvas.onclick = e => {
      const rect = canvas.getBoundingClientRect();
      const geo = canvas._geo;
      if (!geo) return;
      const i = Math.floor((e.clientX - rect.left - geo.padL) / geo.cellW);
      if (i >= 0 && i < state.sim.n) {
        state.selectedSeg = i;
        renderAll();
      }
    };
    canvas.onmousemove = e => {
      const rect = canvas.getBoundingClientRect();
      const geo = canvas._geo;
      if (!geo) return;
      const i = Math.floor((e.clientX - rect.left - geo.padL) / geo.cellW);
      const h = (i >= 0 && i < state.sim.n) ? i : null;
      if (h !== state.hoverSeg) { state.hoverSeg = h; renderTunnelOnly(); }
    };
    canvas.onmouseleave = () => { state.hoverSeg = null; renderTunnelOnly(); };

    // 时间轴
    const tl = $('timelineCanvas');
    tl.onclick = e => {
      const rect = tl.getBoundingClientRect();
      const t = window.Renderer.tickAtX(tl, e.clientX - rect.left);
      state.selectedTick = Math.min(t, state.sim.tick);
      renderTimelineOnly();
      renderHeader();
    };
    $('seekBtn').onclick = () => seekFromSelected();
    $('savePlanBtn').onclick = () => saveCurrentPlan();

    // 方案对比
    $('compareBtn').onclick = openCompare;

    window.addEventListener('resize', () => renderAll());
  }

  function syncControlsFromSim() {
    $('densitySel').value = state.sim.density || 'medium';
    if (state.sim.fire) {
      $('fireSeg').value = state.sim.fire.seg;
      $('fireSegVal').textContent = state.sim.fire.seg;
      state.fireLevel = state.sim.fire.level;
      $('fireLevel').querySelectorAll('.seg-btn').forEach(b =>
        b.classList.toggle('active', +b.dataset.level === state.sim.fire.level));
    }
  }

  // ---------- 风机 / 出口列表 ----------
  function renderFanList() {
    const box = $('fanList');
    box.innerHTML = state.sim.fans.map(f => {
      const d = f.dir;
      return '<div class="fan-item"><span class="name">' + f.id +
        ' <span class="pos">#' + f.seg + ' 区段</span></span>' +
        '<button class="mini-btn ' + (d === -1 ? 'active' : '') + '" data-fan="' + f.id + '" data-dir="-1">←</button>' +
        '<button class="mini-btn off ' + (d === 0 ? 'active' : '') + '" data-fan="' + f.id + '" data-dir="0">关</button>' +
        '<button class="mini-btn ' + (d === 1 ? 'active' : '') + '" data-fan="' + f.id + '" data-dir="1">→</button>' +
        '</div>';
    }).join('');
    box.onclick = e => {
      const btn = e.target.closest('.mini-btn'); if (!btn) return;
      command({ type: 'set_fan', fanId: btn.dataset.fan, dir: +btn.dataset.dir });
    };
  }

  function renderExitList() {
    const box = $('exitList');
    box.innerHTML = state.sim.exits.map(ex =>
      '<div class="exit-item ' + (ex.open ? '' : 'closed') + '">' +
      '<span class="name">' + (ex.open ? '🚪' : '🚫') + ' ' + ex.name +
      ' <span class="pos">#' + ex.seg + '</span></span>' +
      '<button class="mini-btn ' + (ex.open ? '' : 'active') + '" data-exit="' + ex.id + '">' +
      (ex.open ? '关闭' : '开放') + '</button></div>'
    ).join('');
    box.onclick = e => {
      const btn = e.target.closest('.mini-btn'); if (!btn) return;
      const ex = state.sim.exits.find(x => x.id === btn.dataset.exit);
      command({ type: 'toggle_exit', exitId: ex.id, open: !ex.open });
    };
  }

  // ---------- 渲染 ----------
  function renderAll() {
    renderHeader();
    renderTunnelOnly();
    window.Renderer.renderMetrics($('metricsRow'), state.sim);
    renderFanList();
    renderExitList();
    renderAlerts();
    renderTimelineOnly();
    if (state.selectedSeg != null) window.Renderer.renderDetail($('detailBody'), state.sim, state.selectedSeg);
    else { $('detailBody').className = 'detail-empty'; $('detailBody').textContent = '未选择区段'; }
    updateButtons();
  }

  function renderHeader() {
    const tick = state.selectedTick != null ? state.selectedTick : state.sim.tick;
    $('simClock').textContent = E.formatClock(tick * C.TICK_SECONDS);
    const pill = $('statusPill');
    const map = { config: ['配置中', ''], running: ['推演中 ●', 'running'], paused: ['已暂停', 'paused'], finished: ['已结束', 'finished'] };
    const s = state.sim.status;
    pill.textContent = map[s][0];
    pill.className = 'status-pill ' + map[s][1];
    $('fireSeg').disabled = !!state.sim.fire;
    $('igniteBtn').disabled = !!state.sim.fire;
  }

  function renderTunnelOnly() {
    const canvas = $('tunnelCanvas');
    canvas._geo = window.Renderer.renderTunnel(canvas, state.sim, {
      hoverSeg: state.hoverSeg, selectedSeg: state.selectedSeg
    });
  }

  function renderTimelineOnly() {
    window.Renderer.renderTimeline($('timelineCanvas'), state.sim, state.selectedTick);
    renderTimelineEvents();
    const canSeek = state.selectedTick != null && state.selectedTick < state.sim.tick;
    $('seekBtn').disabled = !canSeek;
    $('savePlanBtn').disabled = !state.sim.fire;
  }

  function renderTimelineEvents() {
    const box = $('timelineEvents');
    const evs = state.sim.timeline.filter(e =>
      ['set_fire', 'set_density', 'set_fan', 'toggle_exit', 'alert_start', 'branch', 'finish', 'fire_out'].includes(e.kind))
      .slice(-40);
    box.innerHTML = evs.map(e => {
      const cls = e.kind === 'alert_start' ? 'alert' : e.kind === 'branch' ? 'branch' : '';
      const sel = state.selectedTick === e.tick ? 'selected' : '';
      return '<span class="tl-event ' + cls + ' ' + sel + '" data-tick="' + e.tick + '">' +
        '<span class="t">' + E.formatClock(e.time) + '</span>' + eventLabel(e) + '</span>';
    }).join('');
    box.onclick = ev => {
      const el = ev.target.closest('.tl-event'); if (!el) return;
      const t = Math.min(+el.dataset.tick, state.sim.tick);
      state.selectedTick = state.selectedTick === t ? null : t;
      renderTimelineOnly();
      renderHeader();
    };
  }

  function eventLabel(e) {
    if (e.label) return e.label;
    if (e.kind === 'start') return '启动推演';
    if (e.kind === 'pause') return '暂停';
    if (e.kind === 'step') return '单步';
    if (e.kind === 'alert_start') return '⚠ ' + e.alert.title;
    if (e.kind === 'alert_end') return '告警解除: ' + e.title;
    if (e.kind === 'finish') return '推演结束';
    if (e.kind === 'fire_out') return '明火熄灭';
    return e.kind;
  }

  function renderAlerts() {
    const banner = $('alertBanner');
    const alerts = state.sim.alerts || [];
    if (!alerts.length) {
      $('alertList').innerHTML = '<div class="muted">暂无告警</div>';
      banner.hidden = true;
      return;
    }
    banner.style.background = '';
    banner.style.borderBottomColor = '';
    banner.style.color = '';
    $('alertList').innerHTML = alerts.map(a =>
      '<div class="alert-item ' + a.severity + '">' +
      '<div class="at-title">' + (a.severity === 'critical' ? '🔴 ' : '🟡 ') + a.title + '</div>' +
      '<div class="at-msg">' + a.message + '</div>' +
      '<div class="at-meta">影响 ' + (a.affectedPeople || 0) + ' 人 · 区段 ' +
      (a.fromSeg != null ? a.fromSeg + '–' + a.toSeg : '—') +
      ' · 始于 ' + E.formatClock(a.firstTick * C.TICK_SECONDS) + '</div></div>'
    ).join('');
    const critical = alerts.filter(a => a.severity === 'critical');
    if (critical.length) {
      banner.hidden = false;
      banner.innerHTML = '🔴 ' + critical.map(a => a.title + ' (区段 ' + a.fromSeg + '–' + a.toSeg +
        ', ' + a.affectedPeople + ' 人受影响)').join('　');
    } else {
      banner.hidden = false;
      banner.style.background = 'rgba(251,191,36,.12)';
      banner.style.borderBottomColor = 'rgba(251,191,36,.4)';
      banner.style.color = '#fde68a';
      banner.innerHTML = '🟡 ' + alerts.map(a => a.title).join('　');
    }
  }

  function updateButtons() {
    const s = state.sim.status;
    const hasFire = !!state.sim.fire;
    $('startBtn').disabled = !hasFire || s === 'running' || s === 'finished';
    $('pauseBtn').disabled = s !== 'running';
    $('stepBtn').disabled = !hasFire || s === 'running' || s === 'finished';
  }

  // ---------- 时间节点继续 (分支) ----------
  function seekFromSelected() {
    if (state.selectedTick == null || state.selectedTick >= state.sim.tick) return;
    stopLoop();
    const target = state.selectedTick;
    const r = E.seekTo(state.sim, target);
    if (!r.ok) { toast('无法回到该节点: ' + r.error); return; }
    state.sim = r.sim;
    state.selectedTick = null;
    markDirty(); persist();
    renderAll();
    toast('已回到 t=' + E.formatClock(target * C.TICK_SECONDS) + ', 此后的操作将形成新的决策分支', 'ok', 5000);
  }

  // ---------- 方案保存 / 列表 / 对比 ----------
  async function saveCurrentPlan() {
    const name = prompt('方案名称', '方案 ' + (state.plans.length + 1) + ' (t=' +
      E.formatClock(state.sim.tick * C.TICK_SECONDS) + ')');
    if (!name) return;
    // 先跑到当前时刻的快照已经存在于 state.sim, 直接导出
    const plan = E.exportPlan(state.sim, name);
    delete plan.id;   // 由存储层生成独立方案 id, 避免多次保存互相覆盖
    const saved = await window.Api.savePlan(plan);
    state.chosenPlans.add(saved.id);
    await refreshPlans();
    toast('方案「' + name + '」已保存, 可在右侧选择方案进行同步回放对比', 'ok');
  }

  async function refreshPlans() {
    state.plans = await window.Api.listPlans();
    const box = $('planList');
    if (!state.plans.length) {
      box.innerHTML = '<div class="muted">尚无保存方案, 完成一轮风机/出口处置后点击"存为方案"</div>';
      $('compareBtn').disabled = true;
      return;
    }
    box.innerHTML = state.plans.map(p => {
      const sel = state.chosenPlans.has(p.id);
      const s = p.summary || {};
      return '<div class="plan-item ' + (sel ? 'selected' : '') + '" data-plan="' + p.id + '">' +
        '<div class="pn"><span>' + (sel ? '☑' : '☐') + ' ' + p.name + '</span>' +
        '<span style="color:var(--muted);font-weight:400">' +
        new Date(p.savedAt).toLocaleTimeString('zh-CN', { hour12: false }) + '</span></div>' +
        '<div class="pm">完成 ' + E.formatClock((p.finalTick || 0) * C.TICK_SECONDS) +
        ' ｜ 撤离 ' + (s.evacuated != null ? s.evacuated : '-') +
        ' ｜ 被困 ' + (s.trapped != null ? s.trapped : '-') + '</div>' +
        '<div class="pa"><button class="btn small" data-act="load">载入</button>' +
        '<button class="btn small danger" data-act="del">删除</button></div></div>';
    }).join('');

    box.onclick = async e => {
      const item = e.target.closest('.plan-item'); if (!item) return;
      const id = item.dataset.plan;
      const actEl = e.target.closest('[data-act]');
      const act = actEl ? actEl.dataset.act : null;
      if (act === 'del') {
        await window.Api.deletePlan(id);
        state.chosenPlans.delete(id);
        refreshPlans();
        return;
      }
      if (act === 'load') {
        const full = await window.Api.getPlan(id);
        if (!full) { toast('方案数据缺失'); return; }
        stopLoop();
        const rebuilt = E.replay(full.config, full.decisions, full.finalTick);
        state.sim = rebuilt;
        state.selectedTick = null;
        markDirty(); renderAll();
        toast('已载入方案「' + full.name + '」的最终状态', 'ok');
        return;
      }
      // 行点击 (非按钮区域): 勾选用于对比
      if (state.chosenPlans.has(id)) state.chosenPlans.delete(id);
      else {
        if (state.chosenPlans.size >= 4) { toast('最多同时对比 4 个方案'); return; }
        state.chosenPlans.add(id);
      }
      refreshPlans();
    };
    $('compareBtn').disabled = state.chosenPlans.size < 2;
  }

  async function openCompare() {
    const ids = [...state.chosenPlans];
    const full = [];
    for (const id of ids) {
      const p = await window.Api.getPlan(id);
      if (p) full.push(p);
    }
    if (full.length < 2) { toast('请勾选至少两个方案'); return; }
    window.Compare.open(full);
  }

  init();
})();
