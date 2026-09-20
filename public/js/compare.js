/* 多方案同步回放对比 */
(function () {
  const C = window.CONSTANTS;
  const E = window.SimEngine;

  const PALETTE = ['#38bdf8', '#fbbf24', '#34d399', '#fb7185', '#c084fc', '#f472b6'];

  // 为每个方案构造完整重放序列 (逐 tick 状态)
  function buildSeries(plan) {
    const frames = [];
    const maxTick = plan.finalTick || C.MAX_TICKS;
    sim = rebuildAndRun(plan, maxTick, (s, t) => { frames.push(snapshot(s)); });
    return { plan: plan, frames: frames, sim: sim };
  }

  // 复用 engine.replay 的确定性决策序列, 但逐帧回调
  function rebuildAndRun(plan, toTick, onFrame) {
    const sim = E.createSim({
      seed: plan.config.seed, density: plan.config.density,
      segments: plan.config.segments, name: plan.config.name,
      fans: plan.config.fans, exits: plan.config.exits
    });
    sim.metrics = [];
    const byTick = {};
    (plan.decisions || []).forEach(d => { (byTick[d.tick] = byTick[d.tick] || []).push(d); });
    if (onFrame) onFrame(sim, 0);
    for (let t = 1; t <= toTick; t++) {
      (byTick[t - 1] || []).forEach(d => E.apply(sim, d));
      const r = E.step(sim);
      if (!r.ok) break;
      if (sim.status === C.STATUS.RUNNING) sim.status = C.STATUS.PAUSED;
      if (onFrame) onFrame(sim, t);
      if (sim.status === C.STATUS.FINISHED) break;
    }
    return sim;
  }

  function snapshot(sim) {
    return {
      tick: sim.tick,
      evacuated: sim.totals.evacuated || 0,
      trapped: sim.totals.trapped || 0,
      total: sim.totals.initialPeople || sim.segments.reduce((x, s) => x + s.vehicles.length, 0),
      danger: sim.segments.filter(s => {
        const l = E.dangerLevel(s); return l === 'danger' || l === 'lethal';
      }).length,
      alerts: sim.alerts.map(a => ({ type: a.type, severity: a.severity, title: a.title, fromSeg: a.fromSeg, toSeg: a.toSeg }))
    };
  }

  function open(plans) {
    if (plans.length < 2) { App.toast('请至少选择两个方案进行对比'); return; }
    const series = plans.slice(0, 4).map(buildSeries);
    const modal = document.getElementById('compareModal');
    const charts = document.getElementById('compareCharts');
    const table = document.getElementById('compareTable');
    modal.hidden = false;

    const maxFrames = Math.max(...series.map(s => s.frames.length - 1));
    const scrub = document.getElementById('cmpScrub');
    scrub.max = maxFrames; scrub.value = maxFrames;

    charts.innerHTML =
      '<div class="cmp-chart"><h3>人员撤离进度 (累计撤离人数)</h3><canvas id="chartEvac" height="150"></canvas></div>' +
      '<div class="cmp-chart"><h3>受困人员数量</h3><canvas id="chartTrap" height="150"></canvas></div>' +
      '<div class="cmp-chart"><h3>危险区段范围 (区段数)</h3><canvas id="chartDanger" height="150"></canvas></div>';

    drawCharts(series, maxFrames);
    drawTable(series);
    document.getElementById('cmpClock').textContent = E.formatClock(maxFrames * C.TICK_SECONDS);

    let playing = false, timer = null;
    const playBtn = document.getElementById('cmpPlay');
    const pauseBtn = document.getElementById('cmpPause');
    playBtn.onclick = () => {
      playing = true;
      if (+scrub.value >= maxFrames) scrub.value = 0;
      timer = setInterval(() => {
        let v = +scrub.value + 2;
        if (v >= maxFrames) { v = maxFrames; playing = false; clearInterval(timer); }
        scrub.value = v;
        drawCharts(series, v);
        document.getElementById('cmpClock').textContent = E.formatClock(v * C.TICK_SECONDS);
      }, 120);
    };
    pauseBtn.onclick = () => { playing = false; clearInterval(timer); };
    scrub.oninput = () => {
      playing = false; clearInterval(timer);
      drawCharts(series, +scrub.value);
      document.getElementById('cmpClock').textContent = E.formatClock(+scrub.value * C.TICK_SECONDS);
    };
    document.getElementById('closeCompare').onclick = () => {
      playing = false; clearInterval(timer); modal.hidden = true;
    };
  }

  function drawCharts(series, cursorTick) {
    drawLineChart('chartEvac', series, f => f.evacuated, cursorTick, '人');
    drawLineChart('chartTrap', series, f => f.trapped, cursorTick, '人');
    drawLineChart('chartDanger', series, f => f.danger, cursorTick, '段');
  }

  function drawLineChart(canvasId, series, pick, cursor, unit) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = 150;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const padL = 44, padB = 22, padT = 10, padR = 12;
    const maxT = Math.max(...series.map(s => s.frames.length - 1));
    let maxV = 1;
    series.forEach(s => s.frames.forEach(f => { maxV = Math.max(maxV, pick(f)); }));
    const xAt = t => padL + (t / Math.max(1, maxT)) * (W - padL - padR);
    const yAt = v => padT + (1 - v / maxV) * (H - padT - padB);

    // 网格
    ctx.strokeStyle = 'rgba(70,90,115,.25)'; ctx.fillStyle = '#6b8299';
    ctx.font = '9.5px "SF Mono",Menlo'; ctx.textAlign = 'right';
    for (let g = 0; g <= 4; g++) {
      const v = maxV * g / 4, y = yAt(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(Math.round(v), padL - 5, y + 3);
    }
    ctx.textAlign = 'center';
    for (let t = 0; t <= maxT; t += Math.max(1, Math.round(maxT / 8))) {
      ctx.fillText(E.formatClock(t * C.TICK_SECONDS), xAt(t), H - 7);
    }

    series.forEach((s, si) => {
      const color = PALETTE[si];
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      const upto = Math.min(cursor, s.frames.length - 1);
      for (let t = 0; t <= upto; t++) {
        const x = xAt(t), y = yAt(pick(s.frames[t]));
        t === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      // 当前点
      const f = s.frames[upto];
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(xAt(upto), yAt(pick(f)), 3.5, 0, Math.PI * 2); ctx.fill();
    });

    // 图例
    ctx.textAlign = 'left'; ctx.font = '11px "PingFang SC",sans-serif';
    series.forEach((s, si) => {
      const x = padL + 8 + si * 150;
      ctx.fillStyle = PALETTE[si];
      ctx.fillRect(x, padT - 4, 9, 9);
      ctx.fillStyle = '#b9cbdf';
      ctx.fillText(s.plan.name, x + 13, padT + 4);
    });
  }

  function drawTable(series) {
    const tbl = document.getElementById('compareTable');
    let head = '<tr><th>指标</th>' + series.map((s, i) =>
      '<th><span class="plan-swatch" style="background:' + PALETTE[i] + '"></span>' + s.plan.name + '</th>').join('') + '</tr>';

    const row = (label, vals, fmt, bad) => '<tr><td>' + label + '</td>' + vals.map(v =>
      '<td class="' + (bad && bad(v) ? 'bad' : '') + '">' + fmt(v) + '</td>').join('') + '</tr>';

    const sums = series.map(s => s.sim && s.sim.totals ? {
      evac: s.sim.totals.evacuated, trapped: s.sim.totals.trapped,
      total: s.sim.totals.initialPeople, finish: s.sim.finishedAt || s.sim.tick
    } : s.plan.summary);

    head += row('初始受影响人员', sums, v => v.total);
    head += row('成功撤离', sums, v => v.evac + ' 人 (' + (v.total ? Math.round(v.evac / v.total * 100) : 0) + '%)');
    head += row('被困人员', sums, v => v.trapped + ' 人', v => v.trapped > 0);
    const finishTimes = sums.map(v => v.finish);
    const bestT = Math.min(...finishTimes);
    head += row('预计完成时间', sums, v => E.formatClock(v.finish * C.TICK_SECONDS), v => v.finish > bestT);

    // 决策统计 + 冲突/不可用出口
    const problems = series.map(s => {
      const conflicts = new Set();
      const blockedExits = new Set();
      (s.plan.decisions || []).forEach(d => {
        if (d.type === 'toggle_exit' && !d.open) blockedExits.add(d.exitId);
      });
      // 从最终帧告警获取冲突
      const last = s.frames[s.frames.length - 1];
      let hadConflict = false, hadTrap = false;
      for (let t = 0; t < s.frames.length; t++) {
        if (s.frames[t].alerts.some(a => a.type === C.ALERT_TYPES.FAN_CONFLICT)) hadConflict = true;
        if (s.frames[t].alerts.some(a => a.type === C.ALERT_TYPES.TRAPPED)) hadTrap = true;
      }
      return {
        fanOps: (s.plan.decisions || []).filter(d => d.type === 'set_fan').length,
        conflicts: hadConflict, blocked: blockedExits.size, trapped: hadTrap
      };
    });
    head += row('风机操作次数', problems, v => v.fanOps);
    head += row('风机冲突', problems, v => v.conflicts ? '⚠ 出现对射紊流' : '无', v => v.conflicts);
    head += row('关闭的出口', problems, v => v.blocked ? v.blocked + ' 处' : '无', v => v.blocked > 0);

    // 原因与影响范围明细
    head += '<tr><td>关键风险与影响</td>' + series.map((s, i) => {
      const msgs = [];
      const seen = new Set();
      for (let t = 0; t < s.frames.length; t++) {
        s.frames[t].alerts.forEach(a => {
          const key = a.title + a.fromSeg;
          if ((a.severity === 'critical' || a.type === 'fan_conflict') && !seen.has(key)) {
            seen.add(key);
            const rng = a.fromSeg != null ? ' [' + a.fromSeg + '–' + a.toSeg + ' 区段]' : '';
            msgs.push('• ' + a.title + rng);
          }
        });
      }
      return '<td style="text-align:left;font-size:11px;color:' + (msgs.length ? '#fecdd3' : 'var(--muted)') + '">' +
        (msgs.slice(0, 5).join('<br>') || '无显著风险') + '</td>';
    }).join('') + '</tr>';

    document.getElementById('compareTable').innerHTML = head;
  }

  window.Compare = { open: open };
})();
