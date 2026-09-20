/* 隧道场景 / 时间轴 / 面板渲染 */
(function () {
  const C = window.CONSTANTS;
  const E = window.SimEngine;

  const COLORS = {
    safe: 'rgba(52,211,153,0.10)',
    warn: 'rgba(251,191,36,0.20)',
    danger: 'rgba(251,113,133,0.34)',
    lethal: 'rgba(192,132,252,0.48)'
  };

  // ---------- 隧道主画布 ----------
  function renderTunnel(canvas, sim, opts) {
    opts = opts || {};
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = parseInt(canvas.getAttribute('height'));
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const n = sim.n;
    const padL = 46, padR = 16;
    const cellW = (W - padL - padR) / n;
    const roadTop = 96, roadH = 92, laneH = roadH / 2;

    // 区段危险底色 + 烟雾层
    for (let i = 0; i < n; i++) {
      const x = padL + i * cellW;
      const seg = sim.segments[i];
      const lvl = E.dangerLevel(seg);
      ctx.fillStyle = COLORS[lvl] || COLORS.safe;
      ctx.fillRect(x, 40, cellW + 0.6, roadH + 70);

      // 烟雾浓度叠加 (灰)
      if (seg.smoke > 0.02) {
        ctx.fillStyle = 'rgba(150,160,175,' + (seg.smoke * 0.62).toFixed(3) + ')';
        ctx.fillRect(x, 40, cellW + 0.6, roadH + 70);
      }
      // 区段分隔线
      ctx.strokeStyle = 'rgba(80,100,125,.35)';
      ctx.beginPath(); ctx.moveTo(x, 40); ctx.lineTo(x, roadTop + roadH + 70); ctx.stroke();
      // 区段编号
      ctx.fillStyle = '#62798f';
      ctx.font = '9px "SF Mono",Menlo';
      ctx.textAlign = 'center';
      ctx.fillText(i, x + cellW / 2, 32);
    }

    // 隧道边框 + 路面
    ctx.fillStyle = '#111a26';
    ctx.fillRect(padL, roadTop, n * cellW, roadH);
    ctx.strokeStyle = '#3c5068'; ctx.lineWidth = 1.5;
    ctx.strokeRect(padL, roadTop, n * cellW, roadH);
    // 车道虚线
    ctx.strokeStyle = 'rgba(200,215,230,.35)'; ctx.setLineDash([7, 6]);
    ctx.beginPath(); ctx.moveTo(padL, roadTop + laneH); ctx.lineTo(padL + n * cellW, roadTop + laneH); ctx.stroke();
    ctx.setLineDash([]);

    // 烟雾蔓延方向箭头 (按风场)
    ctx.lineWidth = 2;
    for (let i = 0; i < n; i++) {
      if (sim.segments[i].smoke < 0.08) continue;
      const x = padL + i * cellW + cellW / 2;
      const w = sim.wind[i] || 0;
      const dir = w >= 0 ? 1 : -1;
      const mag = Math.min(1, Math.abs(w));
      const y = 58;
      ctx.strokeStyle = 'rgba(220,225,235,' + (0.35 + mag * 0.55) + ')';
      ctx.fillStyle = ctx.strokeStyle;
      const len = 6 + mag * 12;
      ctx.beginPath();
      ctx.moveTo(x - dir * len / 2, y);
      ctx.lineTo(x + dir * len / 2, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + dir * (len / 2 + 5), y);
      ctx.lineTo(x + dir * len / 2, y - 3.5);
      ctx.lineTo(x + dir * len / 2, y + 3.5);
      ctx.closePath(); ctx.fill();
    }

    // 车辆
    sim.segments.forEach((seg, i) => {
      seg.vehicles.forEach(v => {
        const x = padL + i * cellW + (v.x / C.SEGMENT_LENGTH) * cellW;
        const y = roadTop + v.lane * laneH + laneH / 2;
        ctx.fillStyle = v.abandoned ? '#5b7186' : (v.truck ? '#e8b04b' : '#7dd3fc');
        const w = v.truck ? cellW * 0.42 : cellW * 0.28;
        roundRect(ctx, x - w / 2, y - 4.5, w, 9, 2); ctx.fill();
      });
    });

    // 疏散人员 (步行绿点 / 被困紫点)
    sim.people.forEach(p => {
      const x = padL + (p.pos / (n * C.SEGMENT_LENGTH)) * n * cellW;
      let y = roadTop + roadH + 14;
      const si = Math.min(n - 1, Math.floor(p.pos / C.SEGMENT_LENGTH));
      y += ((p.id.charCodeAt(1) * 7) % 3) * 9;
      if (p.state === 'evacuated') return;
      ctx.fillStyle = p.state === 'trapped' ? '#c084fc' : '#86efac';
      ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
    });

    // 起火标记
    if (sim.fire) {
      const fx = padL + sim.fire.seg * cellW + cellW / 2;
      ctx.font = '18px serif'; ctx.textAlign = 'center';
      ctx.fillText('🔥', fx, roadTop - 8);
    }

    // 风机
    sim.fans.forEach(f => {
      const x = padL + f.seg * cellW + cellW / 2;
      const y = roadTop + roadH + 52;
      ctx.font = '13px serif'; ctx.textAlign = 'center';
      ctx.fillStyle = f.dir === 0 ? '#5c7188' : '#38bdf8';
      const glyph = f.dir === 1 ? '🌀→' : f.dir === -1 ? '←🌀' : '🌀';
      ctx.fillText(glyph, x, y);
      ctx.fillStyle = '#7088a0'; ctx.font = '8.5px "SF Mono",Menlo';
      ctx.fillText(f.id, x, y + 11);
    });

    // 出口 / 横通道
    sim.exits.forEach(ex => {
      const x = padL + ex.seg * cellW + cellW / 2;
      ctx.fillStyle = ex.open ? '#34d399' : '#fb7185';
      ctx.beginPath();
      ctx.arc(x, roadTop + roadH + 30, 3.5, 0, Math.PI * 2); ctx.fill();
      if (!ex.open) {
        ctx.strokeStyle = '#fb7185'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x - 5, roadTop + roadH + 25); ctx.lineTo(x + 5, roadTop + roadH + 35);
        ctx.moveTo(x + 5, roadTop + roadH + 25); ctx.lineTo(x - 5, roadTop + roadH + 35);
        ctx.stroke();
      }
      ctx.fillStyle = ex.open ? '#7ea3bf' : '#fb7185';
      ctx.font = '8.5px "PingFang SC",sans-serif';
      ctx.fillText(ex.kind === 'portal' ? '洞口' : '横通道', x, roadTop - 20);
    });

    // 高亮选中区段 / hover
    [opts.hoverSeg, opts.selectedSeg].forEach((s, idx) => {
      if (s == null) return;
      const x = padL + s * cellW;
      ctx.strokeStyle = idx === 1 ? '#38bdf8' : 'rgba(56,189,248,.45)';
      ctx.lineWidth = idx === 1 ? 2 : 1;
      ctx.strokeRect(x + 1, 41, cellW - 2, roadH + 68);
    });

    // 告警影响区段红色虚框
    (sim.alerts || []).forEach(a => {
      if (a.fromSeg == null) return;
      const x = padL + a.fromSeg * cellW;
      const w = (a.toSeg - a.fromSeg + 1) * cellW;
      ctx.strokeStyle = a.severity === 'critical' ? 'rgba(251,80,110,.9)' : 'rgba(251,191,36,.85)';
      ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 2, 42, w - 4, roadH + 66);
      ctx.setLineDash([]);
    });

    return { padL: padL, cellW: cellW, top: 40, height: roadH + 70 };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- 时间轴 ----------
  function renderTimeline(canvas, sim, selectedTick) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = parseInt(canvas.getAttribute('height'));
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const maxTick = Math.max(sim.tick, 30);
    const xAt = t => 10 + (t / C.MAX_TICKS) * (W - 20);
    const baseY = H - 24;

    // 主轴
    ctx.strokeStyle = '#33445c'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(10, baseY); ctx.lineTo(W - 10, baseY); ctx.stroke();

    // 已走过部分
    ctx.strokeStyle = '#38bdf8';
    ctx.beginPath(); ctx.moveTo(10, baseY); ctx.lineTo(xAt(sim.tick), baseY); ctx.stroke();

    // 刻度 (每分钟)
    ctx.fillStyle = '#5d748c'; ctx.font = '9px "SF Mono",Menlo'; ctx.textAlign = 'center';
    for (let t = 0; t <= C.MAX_TICKS; t += 6) {
      const x = xAt(t);
      ctx.strokeStyle = '#24344a';
      ctx.beginPath(); ctx.moveTo(x, baseY - 3); ctx.lineTo(x, baseY + 3); ctx.stroke();
      if (t % 30 === 0) ctx.fillText(E.formatClock(t * C.TICK_SECONDS), x, H - 6);
    }

    // 事件标记
    sim.timeline.forEach(ev => {
      const x = xAt(ev.tick);
      let color = '#64748b', y = baseY - 12;
      if (ev.kind === 'alert_start') { color = ev.alert.severity === 'critical' ? '#fb7185' : '#fbbf24'; y = baseY - 26; }
      else if (ev.kind === 'alert_end') { color = '#475569'; y = baseY - 26; }
      else if (ev.kind === 'branch') { color = '#fbbf24'; y = baseY - 40; }
      else if (['set_fire', 'set_fan', 'toggle_exit', 'set_density'].includes(ev.kind)) { color = '#38bdf8'; }
      else if (ev.kind === 'finish') { color = '#34d399'; }
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y + 3); ctx.lineTo(x, baseY - 1); ctx.stroke();
    });

    // 当前/选中游标
    const cur = selectedTick != null ? selectedTick : sim.tick;
    ctx.strokeStyle = '#e2f3ff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(xAt(cur), 8); ctx.lineTo(xAt(cur), baseY + 6); ctx.stroke();

    return { xAt: xAt };
  }

  function tickAtX(canvas, x) {
    const W = canvas.clientWidth;
    const t = Math.round((x - 10) / (W - 20) * C.MAX_TICKS);
    return Math.max(0, Math.min(C.MAX_TICKS, t));
  }

  // ---------- 指标条 ----------
  function renderMetrics(container, sim) {
    const total = sim.totals.initialPeople;
    const evac = sim.totals.evacuated || 0;
    const trapped = sim.totals.trapped || 0;
    const dangerCount = sim.segments.filter(s => E.dangerLevel(s) === 'danger' || E.dangerLevel(s) === 'lethal').length;
    const m = sim.metrics[sim.metrics.length - 1];
    const items = [
      { k: '受影响人员', v: total, u: '人', cls: 'info' },
      { k: '已撤离', v: evac, u: '人', cls: 'good' },
      { k: '被困', v: trapped, u: '人', cls: trapped ? 'bad' : '' },
      { k: '危险区段', v: dangerCount, u: '段', cls: dangerCount ? 'warn' : '' },
      { k: '剩余疏散时间', v: m && m.eta ? E.formatClock(m.eta * C.TICK_SECONDS) : '—', cls: m && m.eta ? 'info' : '' },
      { k: '在车车辆', v: sim.segments.reduce((x, s) => x + s.vehicles.filter(v => !v.abandoned).length, 0), u: '辆' }
    ];
    container.innerHTML = items.map(it =>
      '<div class="metric ' + it.cls + '"><div class="k">' + it.k + '</div>' +
      '<div><span class="v">' + it.v + '</span><span class="u">' + (it.u || '') + '</span></div></div>'
    ).join('');
  }

  // ---------- 区段详情 ----------
  function renderDetail(container, sim, i) {
    const d = E.segmentDetail(sim, i);
    if (!d) { container.className = 'detail-empty'; container.textContent = '未选择区段'; return; }
    container.className = '';
    const lvlText = { safe: '正常', warn: '预警', danger: '危险', lethal: '致命' }[d.dangerLevel];
    const lvlColor = { safe: 'var(--safe)', warn: 'var(--warn)', danger: 'var(--danger)', lethal: 'var(--lethal)' }[d.dangerLevel];
    const fanText = d.fans.length ? d.fans.map(f => f.id + (f.dir === 1 ? '→' : f.dir === -1 ? '←' : '关')).join('，') : '无';
    const exitText = d.exits.length ? d.exits.map(e => e.name + (e.open ? '' : '(关闭)')).join('，') : '无';
    const chips = d.people.slice(0, 60).map(p =>
      '<span class="person-chip ' + (p.state === 'trapped' ? 'trapped' : '') + '">' +
      p.id + (p.state === 'trapped' ? ' 被困' : p.state === 'evacuated' ? ' 已撤离' : ' 撤离中') +
      (p.eta && p.state === 'walking' ? ' ETA ' + E.formatClock(p.eta * C.TICK_SECONDS) : '') + '</span>'
    ).join('');
    container.innerHTML =
      '<div class="detail-grid">' +
      stat('区段', '#' + d.index + ' <span style="color:' + lvlColor + '">● ' + lvlText + '</span>') +
      stat('烟雾浓度', (d.smoke * 100).toFixed(0) + '%') +
      stat('能见度', d.visibility.toFixed(1) + ' m') +
      stat('温度', d.temp.toFixed(0) + ' °C') +
      stat('车辆', d.vehicles + ' 辆') +
      stat('步行疏散', d.walking + ' 人') +
      stat('被困人员', d.trapped + ' 人', d.trapped ? 'color:var(--danger)' : '') +
      stat('纵向风速', (d.wind >= 0 ? '+' : '') + d.wind.toFixed(2)) +
      '</div>' +
      '<div style="margin-top:10px;font-size:11.5px;color:var(--muted)">风机: ' + fanText +
      ' ｜ 通道: ' + exitText + '</div>' +
      '<div class="affected-list">' + (chips || '<span class="muted">该区段当前无人员</span>') + '</div>';
  }

  function stat(k, v, style) {
    return '<div class="detail-stat"><div class="k">' + k + '</div><div class="v" style="' + (style || '') + '">' + v + '</div></div>';
  }

  window.Renderer = {
    renderTunnel: renderTunnel,
    renderTimeline: renderTimeline,
    tickAtX: tickAtX,
    renderMetrics: renderMetrics,
    renderDetail: renderDetail,
    COLORS: COLORS
  };
})();
