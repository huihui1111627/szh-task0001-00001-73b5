'use strict';
/* 隧道火灾通风与疏散推演引擎 (确定性, 浏览器/Node 通用) */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./constants'));
  } else {
    root.SimEngine = factory(root.CONSTANTS);
  }
})(typeof self !== 'undefined' ? self : this, function (C) {

  // ---------- 确定性随机数 ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function defaultFans(n) {
    const fans = [];
    for (let s = 2; s < n - 2; s += 4) {
      fans.push({ id: 'F' + (fans.length + 1), seg: s, dir: C.FAN_DIRS.OFF, thrust: C.FAN_THRUST });
    }
    return fans;
  }

  function defaultExits(n) {
    const exits = [
      { id: 'PW', seg: 0, kind: 'portal', name: '西洞口', open: true },
      { id: 'PE', seg: n - 1, kind: 'portal', name: '东洞口', open: true }
    ];
    for (let s = 6; s < n - 3; s += 6) {
      exits.push({ id: 'CX' + s, seg: s, kind: 'cross', name: s + '# 横通道', open: true });
    }
    return exits;
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // ---------- 创建仿真 ----------
  function createSim(config) {
    config = config || {};
    const n = config.segments || C.SEGMENT_COUNT;
    const fans = config.fans ? clone(config.fans) : defaultFans(n);
    const exits = config.exits ? clone(config.exits) : defaultExits(n);

    const sim = {
      version: 1,
      id: config.id || ('sim_' + Date.now().toString(36)),
      name: config.name || '未命名推演',
      createdAt: config.createdAt || Date.now(),
      seed: config.seed != null ? config.seed : (Math.floor(Math.random() * 1e9) >>> 0),
      n: n,
      tick: 0,
      status: C.STATUS.CONFIG,
      density: config.density || 'medium',
      fire: null,                 // {seg, level, startTick, duration}
      segments: [],
      fans: fans,
      exits: exits,
      people: [],
      wind: new Array(n).fill(0),
      timeline: [],               // 决策/告警事件
      metrics: [],
      alerts: [],
      totals: { initialPeople: 0, evacuated: 0, trapped: 0, dead: 0 },
      finishedAt: null
    };

    for (let i = 0; i < n; i++) {
      sim.segments.push({
        index: i,
        smoke: 0,
        temp: C.AMBIENT_TEMP,
        visibility: C.VIS_MAX,
        vehicles: [],
        zoneExit: null,
        nearestOpenExit: null
      });
    }
    assignExitZones(sim);
    generateTraffic(sim);
    recordMetric(sim);
    return sim;
  }

  // ---------- 交通生成 (确定性) ----------
  function generateTraffic(sim, density) {
    const rng = mulberry32(sim.seed + (density || sim.density).length * 7919);
    sim.density = density || sim.density;
    const perCell = C.TRAFFIC_PER_CELL[sim.density] != null
      ? C.TRAFFIC_PER_CELL[sim.density] : C.TRAFFIC_PER_CELL.medium;
    sim.segments.forEach(seg => { seg.vehicles = []; });
    let vid = 0;
    for (let i = 0; i < sim.n; i++) {
      for (let lane = 0; lane < C.LANE_COUNT; lane++) {
        // 起火区段稍后清空, 这里先生成
        const count = Math.floor(perCell + rng());
        for (let k = 0; k < count; k++) {
          const truck = rng() < C.TRUCK_RATIO;
          const occ = truck
            ? Math.max(1, Math.round(C.TRUCK_OCCUPANTS + rng()))
            : Math.max(1, Math.round(C.OCCUPANTS_PER_VEHICLE + (rng() - 0.5) * 2));
          sim.segments[i].vehicles.push({
            id: 'V' + (vid++),
            lane: lane,
            x: (k + rng()) / Math.max(1, count) * C.SEGMENT_LENGTH,
            truck: truck,
            occupants: occ,
            abandoned: false
          });
        }
      }
    }
  }

  function assignExitZones(sim) {
    const openSegs = sim.exits.filter(e => e.open).map(e => e.seg);
    sim.segments.forEach((seg, i) => {
      let best = null, bestD = Infinity;
      sim.exits.forEach(e => {
        const d = Math.abs(e.seg - i);
        if (d < bestD) { bestD = d; best = e.id; }
      });
      seg.zoneExit = best;
      let bestOpen = null, bestOD = Infinity;
      openSegs.forEach(s => {
        const d = Math.abs(s - i);
        if (d < bestOD) { bestOD = d; bestOpen = s; }
      });
      seg.nearestOpenExit = bestOpen;
    });
  }

  // 起火时: 车内人员下车成为疏散个体; 起火点车辆清空
  function materializePeople(sim) {
    if (sim.people.length > 0) return;
    let pid = 0;
    sim.segments.forEach((seg, i) => {
      seg.vehicles.forEach(v => {
        if (i === sim.fire.seg) {
          for (let k = 0; k < v.occupants; k++) {
            sim.people.push({
              id: 'P' + (pid++),
              pos: i * C.SEGMENT_LENGTH + v.x,
              state: 'trapped',
              trappedTick: sim.fire.startTick,
              exit: null, eta: null
            });
          }
          return; // 起火点车辆损毁, 车内人员受困
        }
        v.abandoned = true;
        sim.people.push({
          id: 'P' + (pid++),
          pos: i * C.SEGMENT_LENGTH + v.x,
          state: 'walking',      // walking | trapped | evacuated
          exit: null,
          eta: null
        });
      });
    });
    sim.totals.initialPeople = sim.people.length;
  }

  // 不可通行区段: 温度致命
  function impassable(sim, i) {
    if (i < 0 || i >= sim.n) return true;
    return sim.segments[i].temp >= C.TEMP_LETHAL;
  }

  // BFS: 每个区段到最近可用出口的距离 (区段跳数)
  function exitDistances(sim) {
    const dist = new Array(sim.n).fill(-1);
    const q = [];
    sim.exits.forEach(e => {
      if (e.open) { dist[e.seg] = 0; q.push(e.seg); }
    });
    while (q.length) {
      const s = q.shift();
      [s - 1, s + 1].forEach(nb => {
        if (nb >= 0 && nb < sim.n && dist[nb] === -1 && !impassable(sim, nb)) {
          dist[nb] = dist[s] + 1;
          q.push(nb);
        }
      });
    }
    return dist;
  }

  function visibilityOf(smoke) {
    return C.VIS_MAX / (1 + C.VIS_K * smoke);
  }

  // 人员在当前环境下的步行速度 (m/tick)
  function walkSpeedAt(sim, segIdx) {
    const seg = sim.segments[segIdx];
    let v = C.WALK_SPEED * C.TICK_SECONDS;
    if (seg.temp >= C.TEMP_DANGER) {
      const f = Math.min(1, (seg.temp - C.TEMP_DANGER) / (C.TEMP_LETHAL - C.TEMP_DANGER));
      v *= (1 - f * (1 - C.WALK_TEMP_FACTOR));
    }
    if (seg.visibility <= C.VIS_DANGER) {
      const f = Math.min(1, (C.VIS_DANGER - seg.visibility) / C.VIS_DANGER);
      v *= (1 - f * (1 - C.WALK_SMOKE_FACTOR));
    }
    return Math.max(0.5, v);
  }

  // ---------- 风场 ----------
  function computeWind(sim) {
    const w = new Array(sim.n).fill(C.AMBIENT_WIND);
    sim.fans.forEach(f => {
      if (f.dir === C.FAN_DIRS.OFF) return;
      for (let r = 0; r <= C.FAN_RANGE; r++) {
        [f.seg - r, f.seg + r].forEach(s => {
          if (s >= 0 && s < sim.n) {
            const decay = 1 - r / (C.FAN_RANGE + 1);
            w[s] += f.dir * f.thrust * decay;
          }
        });
      }
    });
    sim.wind = w.map(x => Math.max(-1.5, Math.min(1.5, x)));
  }

  function transportSmoke(sim) {
    const s = sim.segments.map(g => g.smoke);
    const n = sim.n;
    const next = s.slice();
    for (let i = 0; i < n; i++) {
      const w = sim.wind[i];
      const outUp = s[i] * C.ADVECTION_UPSTREAM;
      const outDown = s[i] * C.ADVECTION_RATE * Math.min(1, Math.abs(w) + 0.25) * (w >= 0 ? 1 : 0.35);
      const outUpstream = w < 0 ? s[i] * C.ADVECTION_RATE * Math.min(1, -w + 0.25) : outUp;
      let fluxDown = 0, fluxUp = 0, diff = 0;
      if (w >= 0) {
        fluxDown = s[i] * C.ADVECTION_RATE * Math.min(1, w + 0.25);
        fluxUp = outUp;
      } else {
        fluxUp = s[i] * C.ADVECTION_RATE * Math.min(1, -w + 0.25);
        fluxDown = outUp;
      }
      diff = s[i] * C.DIFFUSION_RATE;
      let delta = -(fluxDown + fluxUp) - s[i] * C.SMOKE_DECAY;
      if (i + 1 < n) next[i + 1] += fluxDown; else delta += fluxDown;
      if (i - 1 >= 0) next[i - 1] += fluxUp; else delta += fluxUp;
      if (i + 1 < n) { next[i + 1] += diff * 0.5; delta -= diff * 0.5; }
      if (i - 1 >= 0) { next[i - 1] += diff * 0.5; delta -= diff * 0.5; }
      next[i] += delta;
    }
    // 火源补充
    if (sim.fire) {
      const f = sim.fire;
      if (sim.tick >= f.startTick && sim.tick < f.startTick + f.duration) {
        next[f.seg] += C.FIRE_EMIT[f.level];
      }
    }
    for (let i = 0; i < n; i++) {
      sim.segments[i].smoke = Math.max(0, Math.min(1, next[i]));
    }
  }

  function transportHeat(sim) {
    const t = sim.segments.map(g => g.temp);
    const n = sim.n;
    const next = t.slice();
    for (let i = 0; i < n; i++) {
      let gain = 0;
      [i - 1, i + 1].forEach(nb => {
        if (nb >= 0 && nb < n) gain += (t[nb] - t[i]) * C.DIFFUSION_HEAT;
      });
      next[i] += gain - (t[i] - C.AMBIENT_TEMP) * C.HEAT_LOSS;
    }
    if (sim.fire) {
      const f = sim.fire;
      if (sim.tick >= f.startTick && sim.tick < f.startTick + f.duration) {
        next[f.seg] += C.FIRE_HEAT[f.level];
      }
    }
    for (let i = 0; i < n; i++) {
      sim.segments[i].temp = Math.max(C.AMBIENT_TEMP, Math.min(180, next[i]));
      sim.segments[i].visibility = visibilityOf(sim.segments[i].smoke);
    }
  }

  // ---------- 疏散 ----------
  function updatePeople(sim) {
    const dist = exitDistances(sim);
    sim.totals.evacuated = 0;
    sim.totals.trapped = 0;
    let remaining = 0;

    sim.people.forEach(p => {
      if (p.state === 'evacuated') { sim.totals.evacuated++; return; }

      const segIdx = Math.min(sim.n - 1, Math.max(0, Math.floor(p.pos / C.SEGMENT_LENGTH)));
      const seg = sim.segments[segIdx];

      // 致命环境 => 受困/伤亡
      if (seg.temp >= C.TEMP_LETHAL) {
        if (p.state !== 'trapped') {
          p.state = 'trapped';
          p.trappedTick = sim.tick;
        }
        sim.totals.trapped++;
        return;
      }

      const d = dist[segIdx];
      if (d < 0) {
        if (p.state !== 'trapped') {
          p.state = 'trapped';
          p.trappedTick = sim.tick;
        }
        sim.totals.trapped++;
        return;
      }

      // 曾经受困但路径恢复
      if (p.state === 'trapped') p.state = 'walking';

      // 出口到达判定: 横通道在区段任意位置均可撤离; 洞口需到达边界 4m 内
      const exitHere = sim.exits.find(e => e.open && e.seg === segIdx);
      if (exitHere && exitHere.kind === 'cross') {
        p.state = 'evacuated';
        p.exit = exitHere.id;
        sim.totals.evacuated++;
        return;
      }
      if (exitHere && exitHere.kind === 'portal') {
        const atEdge = p.pos - segIdx * C.SEGMENT_LENGTH < 4 || (segIdx + 1) * C.SEGMENT_LENGTH - p.pos < 4;
        if (atEdge) {
          p.state = 'evacuated';
          p.exit = exitHere.id;
          sim.totals.evacuated++;
          return;
        }
      }

      // 朝最近出口移动: 比较两侧 BFS 距离决定方向
      let dir = 0;
      const dL = segIdx - 1 >= 0 ? dist[segIdx - 1] : (sim.exits.some(e => e.open && e.seg === segIdx - 1) ? 0 : -1);
      const dR = segIdx + 1 < sim.n ? dist[segIdx + 1] : -1;
      if (dist[segIdx] === 0) dir = 0;
      else if (dL >= 0 && (dR < 0 || dL < dR)) dir = -1;
      else if (dR >= 0) dir = 1;
      else dir = 0;
      // 已在洞口区段: 朝洞口边界移动
      if (dist[segIdx] === 0 && exitHere && exitHere.kind === 'portal') {
        dir = exitHere.id === 'PW' ? -1 : 1;
      }

      const speed = walkSpeedAt(sim, segIdx);
      p.pos += dir * speed;
      p.pos = Math.max(0, Math.min(sim.n * C.SEGMENT_LENGTH - 0.1, p.pos));

      // 越过出口位置直接撤离
      const crossed = sim.exits.find(e => e.open &&
        (dir > 0 && p.pos >= e.seg * C.SEGMENT_LENGTH && (p.pos - speed) < e.seg * C.SEGMENT_LENGTH) ||
        (dir < 0 && p.pos <= (e.seg + 1) * C.SEGMENT_LENGTH && (p.pos + speed) > (e.seg + 1) * C.SEGMENT_LENGTH));
      if (crossed) {
        p.state = 'evacuated';
        p.exit = crossed.id;
        sim.totals.evacuated++;
        return;
      }

      // ETA
      p.eta = d > 0 ? Math.ceil(d * C.SEGMENT_LENGTH / Math.max(1, speed)) : 0;
      remaining++;
    });

    sim.totals.remaining = remaining;
    sim.evacDist = dist;
  }

  function overallEta(sim) {
    let maxEta = 0;
    sim.people.forEach(p => {
      if (p.state === 'walking' && p.eta != null && p.eta > maxEta) maxEta = p.eta;
    });
    return maxEta;
  }

  // ---------- 告警 ----------
  function pushEvent(sim, entry) {
    sim.timeline.push(Object.assign({ tick: sim.tick, time: sim.tick * C.TICK_SECONDS }, entry));
    if (sim.timeline.length > 2000) sim.timeline.splice(0, sim.timeline.length - 2000);
  }

  function fanConflicts(sim) {
    const out = [];
    const on = sim.fans.filter(f => f.dir !== C.FAN_DIRS.OFF).sort((a, b) => a.seg - b.seg);
    for (let i = 0; i < on.length; i++) {
      for (let j = i + 1; j < on.length; j++) {
        const a = on[i], b = on[j];
        if (b.seg - a.seg > C.FAN_CONFLICT_GAP) break;
        if (a.dir !== b.dir) {
          out.push({
            key: a.id + '_' + b.id,
            a: a.id, b: b.id,
            fromSeg: Math.max(0, a.seg - C.FAN_RANGE),
            toSeg: Math.min(sim.n - 1, b.seg + C.FAN_RANGE),
            message: a.id + ' 与 ' + b.id + ' 对射 (间距 ' + (b.seg - a.seg) + ' 区段), 烟流在 ' +
              Math.max(0, a.seg - C.FAN_RANGE) + '–' + Math.min(sim.n - 1, b.seg + C.FAN_RANGE) + ' 区段形成紊流滞留'
          });
        }
      }
    }
    return out;
  }

  function rebuildAlerts(sim) {
    const prev = {};
    sim.alerts.forEach(a => { prev[a.key] = a; });
    const next = [];

    // 1. 风机冲突
    fanConflicts(sim).forEach(fc => {
      next.push({
        key: 'fc_' + fc.key,
        type: C.ALERT_TYPES.FAN_CONFLICT,
        severity: 'warning',
        title: '风机对射冲突: ' + fc.a + ' ⇄ ' + fc.b,
        message: fc.message,
        fromSeg: fc.fromSeg, toSeg: fc.toSeg,
        affectedPeople: countPeopleInRange(sim, fc.fromSeg, fc.toSeg),
        firstTick: prev['fc_' + fc.key] ? prev['fc_' + fc.key].firstTick : sim.tick
      });
    });

    // 2. 出口不可用
    const dist = sim.evacDist || exitDistances(sim);
    sim.exits.forEach(e => {
      if (e.open) return;
      const segs = [];
      for (let i = 0; i < sim.n; i++) if (sim.segments[i].zoneExit === e.id) segs.push(i);
      const fromSeg = segs[0], toSeg = segs[segs.length - 1];
      const stranded = sim.people.filter(p => {
        const si = Math.floor(p.pos / C.SEGMENT_LENGTH);
        return sim.segments[si] && sim.segments[si].zoneExit === e.id && p.state !== 'evacuated';
      });
      const trappedHere = stranded.filter(p => p.state === 'trapped').length;
      next.push({
        key: 'ex_' + e.id,
        type: C.ALERT_TYPES.EXIT_BLOCKED,
        severity: trappedHere ? 'critical' : 'warning',
        title: '出口不可用: ' + e.name,
        message: '服务区段 ' + fromSeg + '–' + toSeg + ' 人员需改道; 当前滞留 ' +
          stranded.length + ' 人' + (trappedHere ? ', 其中 ' + trappedHere + ' 人已被困' : ''),
        fromSeg: fromSeg, toSeg: toSeg,
        affectedPeople: stranded.length,
        firstTick: prev['ex_' + e.id] ? prev['ex_' + e.id].firstTick : sim.tick
      });
    });

    // 3. 人员被困 (按连续区段分组)
    const trappedSegs = new Set();
    sim.people.forEach(p => {
      if (p.state === 'trapped') trappedSegs.add(Math.floor(p.pos / C.SEGMENT_LENGTH));
    });
    const groups = groupRanges([...trappedSegs].sort((a, b) => a - b));
    groups.forEach((g, gi) => {
      const cnt = sim.people.filter(p => p.state === 'trapped' &&
        Math.floor(p.pos / C.SEGMENT_LENGTH) >= g[0] && Math.floor(p.pos / C.SEGMENT_LENGTH) <= g[1]).length;
      const key = 'tr_' + g[0] + '_' + g[1];
      next.push({
        key: key,
        type: C.ALERT_TYPES.TRAPPED,
        severity: 'critical',
        title: '区段 ' + g[0] + '–' + g[1] + ' 有 ' + cnt + ' 人被困',
        message: '高温或无可用疏散路径, 影响区段 ' + g[0] + '–' + g[1] +
          ', 被困 ' + cnt + ' 人',
        fromSeg: g[0], toSeg: g[1],
        affectedPeople: cnt,
        firstTick: prev[key] ? prev[key].firstTick : sim.tick
      });
    });

    // 新增/解除告警写入时间轴
    const nextMap = {};
    next.forEach(a => { nextMap[a.key] = a; });
    next.forEach(a => {
      if (!prev[a.key]) pushEvent(sim, { kind: 'alert_start', alert: a });
    });
    Object.keys(prev).forEach(k => {
      if (!nextMap[k]) pushEvent(sim, { kind: 'alert_end', alertKey: k, title: prev[k].title });
    });
    sim.alerts = next;
  }

  function countPeopleInRange(sim, from, to) {
    return sim.people.filter(p => {
      const si = Math.floor(p.pos / C.SEGMENT_LENGTH);
      return si >= from && si <= to && p.state !== 'evacuated';
    }).length;
  }

  function groupRanges(nums) {
    const groups = [];
    nums.forEach(v => {
      const g = groups[groups.length - 1];
      if (g && g[1] === v - 1) g[1] = v; else groups.push([v, v]);
    });
    return groups;
  }

  function recordMetric(sim) {
    const dangerSegs = sim.segments.filter(s =>
      s.smoke >= C.SMOKE_DANGER || s.temp >= C.TEMP_DANGER || s.visibility <= C.VIS_DANGER).map(s => s.index);
    const dangerRange = dangerSegs.length
      ? [dangerSegs[0], dangerSegs[dangerSegs.length - 1]] : null;
    sim.metrics.push({
      tick: sim.tick,
      time: sim.tick * C.TICK_SECONDS,
      evacuated: sim.totals.evacuated || 0,
      trapped: sim.totals.trapped || 0,
      remaining: sim.people.length - (sim.totals.evacuated || 0) - (sim.totals.trapped || 0),
      dangerFrom: dangerRange ? dangerRange[0] : null,
      dangerTo: dangerRange ? dangerRange[1] : null,
      eta: overallEta(sim)
    });
    if (sim.metrics.length > C.MAX_TICKS + 1) sim.metrics.shift();
  }

  // ---------- 单步推进 ----------
  function step(sim) {
    if (!sim.fire) return { ok: false, error: '尚未设置起火位置' };
    if (sim.status === C.STATUS.FINISHED) return { ok: false, error: '推演已结束' };

    sim.status = C.STATUS.RUNNING;
    sim.tick += 1;

    // 火灾持续期结束 => 熄灭
    const f = sim.fire;
    computeWind(sim);
    transportHeat(sim);
    transportSmoke(sim);

    if (sim.tick === f.startTick + 1) materializePeople(sim);
    if (sim.people.length) updatePeople(sim);

    rebuildAlerts(sim);
    recordMetric(sim);

    const fireOut = sim.tick >= f.startTick + f.duration;
    const allDone = sim.people.length > 0 &&
      sim.people.every(p => p.state === 'evacuated' || p.state === 'trapped');
    const timeUp = sim.tick >= C.MAX_TICKS;
    if (allDone || timeUp) {
      sim.status = C.STATUS.FINISHED;
      sim.finishedAt = sim.tick;
      pushEvent(sim, { kind: 'finish', summary: summary(sim) });
    } else if (fireOut && sim.tick === f.startTick + f.duration) {
      pushEvent(sim, { kind: 'fire_out', seg: f.seg });
    }

    return { ok: true, sim: sim };
  }

  function summary(sim) {
    const total = sim.totals.initialPeople;
    return {
      totalPeople: total,
      evacuated: sim.totals.evacuated,
      trapped: sim.totals.trapped,
      durationTicks: sim.tick,
      durationSeconds: sim.tick * C.TICK_SECONDS
    };
  }

  // ---------- 命令 (决策) ----------
  // 每个命令: 校验 -> 执行 -> 写时间轴; 校验失败不改状态, 调用方可回滚
  function apply(sim, cmd) {
    const t = cmd.type;

    if (t === 'set_fire') {
      if (sim.fire) return { ok: false, error: '起火点已设置, 请新建推演' };
      const seg = Math.round(cmd.seg);
      if (!(seg >= 0 && seg < sim.n)) return { ok: false, error: '起火区段越界' };
      if (![1, 2, 3].includes(cmd.level)) return { ok: false, error: '火势等级必须为 1/2/3' };
      sim.fire = { seg: seg, level: cmd.level, startTick: sim.tick, duration: C.FIRE_DURATION[cmd.level] };
      sim.segments[seg].vehicles = [];
      sim.status = C.STATUS.PAUSED;
      pushEvent(sim, { kind: 'set_fire', seg: seg, level: cmd.level, label: '起火 @' + seg + ' 区段 (等级 ' + cmd.level + ')' });
      return { ok: true };
    }

    if (t === 'set_density') {
      if (sim.fire) return { ok: false, error: '起火后不可修改交通密度' };
      if (!C.TRAFFIC_PER_CELL[cmd.density]) return { ok: false, error: '未知交通密度' };
      generateTraffic(sim, cmd.density);
      pushEvent(sim, { kind: 'set_density', density: cmd.density, label: '交通密度: ' + cmd.density });
      return { ok: true };
    }

    if (t === 'start') {
      if (!sim.fire) return { ok: false, error: '请先设置起火位置' };
      if (sim.status === C.STATUS.FINISHED) return { ok: false, error: '推演已结束' };
      sim.status = C.STATUS.RUNNING;
      pushEvent(sim, { kind: 'start' });
      return { ok: true };
    }

    if (t === 'pause') {
      if (sim.status !== C.STATUS.RUNNING) return { ok: false, error: '推演未在运行' };
      sim.status = C.STATUS.PAUSED;
      pushEvent(sim, { kind: 'pause' });
      return { ok: true };
    }

    if (t === 'step') {
      if (sim.status === C.STATUS.RUNNING) return { ok: false, error: '运行中请先暂停再单步' };
      const wasStatus = sim.status;
      const r = step(sim);
      if (r.ok) {
        sim.status = C.STATUS.PAUSED;
        pushEvent(sim, { kind: 'step' });
      }
      return r;
    }

    if (t === 'set_fan') {
      const fan = sim.fans.find(f => f.id === cmd.fanId);
      if (!fan) return { ok: false, error: '风机不存在' };
      if (![-1, 0, 1].includes(cmd.dir)) return { ok: false, error: '风机方向非法' };
      if (fan.dir === cmd.dir) return { ok: true, noop: true };
      const old = fan.dir;
      fan.dir = cmd.dir;
      computeWind(sim);
      rebuildAlerts(sim);
      const dirText = cmd.dir === 1 ? '→ 东' : cmd.dir === -1 ? '← 西' : '关闭';
      pushEvent(sim, {
        kind: 'set_fan', fanId: fan.id, dir: cmd.dir, from: old,
        label: fan.id + ' 风向 ' + dirText
      });
      return { ok: true };
    }

    if (t === 'toggle_exit') {
      const ex = sim.exits.find(e => e.id === cmd.exitId);
      if (!ex) return { ok: false, error: '出口不存在' };
      const willOpen = cmd.open != null ? cmd.open : !ex.open;
      if (willOpen === ex.open) return { ok: true, noop: true };
      // 关闭出口前校验: 若会导致已火灾区域完全无路 => 拒绝 (硬失败)
      if (!willOpen && sim.fire) {
        const testDist = exitDistancesWith(sim, ex.id, false);
        const fs = sim.fire.seg;
        if (testDist[fs] < 0) {
          return { ok: false, error: ex.name + ' 关闭后起火区域将无疏散路径' };
        }
      }
      ex.open = willOpen;
      assignExitZones(sim);
      rebuildAlerts(sim);
      pushEvent(sim, {
        kind: 'toggle_exit', exitId: ex.id, open: willOpen,
        label: ex.name + (willOpen ? ' 重新开放' : ' 关闭')
      });
      return { ok: true };
    }

    return { ok: false, error: '未知命令: ' + t };
  }

  function exitDistancesWith(sim, closedExitId, closedOpen) {
    const saved = sim.exits.find(e => e.id === closedExitId).open;
    sim.exits.find(e => e.id === closedExitId).open = closedOpen;
    const d = exitDistances(sim);
    sim.exits.find(e => e.id === closedExitId).open = saved;
    return d;
  }

  // ---------- 重放 / 时间轴跳转 ----------
  // decisions: 仅保留改变物理或场景的决策命令 (set_fire/set_density/set_fan/toggle_exit)
  function decisionCommands(sim) {
    return sim.timeline
      .filter(e => ['set_fire', 'set_density', 'set_fan', 'toggle_exit'].includes(e.kind))
      .map(e => {
        if (e.kind === 'set_fire') return { type: 'set_fire', seg: e.seg, level: e.level, tick: e.tick };
        if (e.kind === 'set_density') return { type: 'set_density', density: e.density, tick: e.tick };
        if (e.kind === 'set_fan') return { type: 'set_fan', fanId: e.fanId, dir: e.dir, tick: e.tick };
        return { type: 'toggle_exit', exitId: e.exitId, open: e.open, tick: e.tick };
      });
  }

  // 从初始配置重放到 toTick, 在各决策 tick 应用命令
  function replay(config, decisions, toTick) {
    const sim = createSim(Object.assign({ seed: config.seed, density: config.density,
      segments: config.segments, name: config.name, fans: config.fans, exits: config.exits }, {}));
    // 重放期间使用与初始一致的风机/出口布局; 清空初始 metric
    sim.metrics = [];
    const byTick = {};
    (decisions || []).forEach(d => {
      (byTick[d.tick] = byTick[d.tick] || []).push(d);
    });
    // density 在 tick 0 的决策需在 metric 之前应用
    recordMetric(sim);
    for (let t = 1; t <= toTick; t++) {
      (byTick[t - 1] || []).forEach(d => {
        apply(sim, { type: d.type, seg: d.seg, level: d.level, density: d.density,
          fanId: d.fanId, dir: d.dir, exitId: d.exitId, open: d.open });
      });
      const r = step(sim);
      if (!r.ok) break;
      if (sim.status === C.STATUS.RUNNING) sim.status = C.STATUS.PAUSED;
      if (sim.status === C.STATUS.FINISHED) break;
    }
    return sim;
  }

  // 从指定时间节点继续: 将当前推演回退到 tick (重放), 供用户重新分支决策
  function seekTo(sim, tick) {
    if (tick < 0 || tick > sim.tick) return { ok: false, error: '时间节点越界' };
    const config = {
      seed: sim.seed, density: sim.density, n: sim.n,
      segments: sim.n, name: sim.name
    };
    const decisions = decisionCommands(sim).filter(d => d.tick <= tick);
    const rebuilt = replay(config, decisions, tick);
    rebuilt.id = sim.id;
    rebuilt.createdAt = sim.createdAt;
    // 截断晚于该节点的时间轴/指标, 标记分支
    rebuilt.timeline.push({ tick: tick, time: tick * C.TICK_SECONDS,
      kind: 'branch', label: '从 t=' + formatClock(tick * C.TICK_SECONDS) + ' 重新决策' });
    return { ok: true, sim: rebuilt };
  }

  function formatClock(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---------- 区段详情 ----------
  function segmentDetail(sim, i) {
    if (i < 0 || i >= sim.n) return null;
    const seg = sim.segments[i];
    const here = sim.people.filter(p => Math.floor(p.pos / C.SEGMENT_LENGTH) === i);
    return {
      index: i,
      smoke: seg.smoke,
      temp: seg.temp,
      visibility: seg.visibility,
      dangerLevel: dangerLevel(seg),
      vehicles: seg.vehicles.length,
      walking: here.filter(p => p.state === 'walking').length,
      trapped: here.filter(p => p.state === 'trapped').length,
      evacuated: here.filter(p => p.state === 'evacuated').length,
      fans: sim.fans.filter(f => f.seg === i).map(f => ({ id: f.id, dir: f.dir })),
      exits: sim.exits.filter(e => e.seg === i).map(e => ({ id: e.id, name: e.name, open: e.open, kind: e.kind })),
      wind: sim.wind[i] || 0,
      people: here
    };
  }

  function dangerLevel(seg) {
    if (seg.temp >= C.TEMP_LETHAL || seg.smoke >= 0.8) return 'lethal';
    if (seg.temp >= C.TEMP_DANGER || seg.smoke >= C.SMOKE_DANGER || seg.visibility <= C.VIS_DANGER) return 'danger';
    if (seg.smoke > 0.08 || seg.temp > C.AMBIENT_TEMP + 10) return 'warn';
    return 'safe';
  }

  // ---------- 方案导出 ----------
  function exportPlan(sim, planName) {
    return {
      version: 1,
      name: planName || sim.name,
      savedAt: Date.now(),
      config: {
        seed: sim.seed, density: sim.density, segments: sim.n, name: sim.name,
        fans: sim.fans.map(f => ({ id: f.id, seg: f.seg, dir: C.FAN_DIRS.OFF, thrust: f.thrust })),
        exits: sim.exits.map(e => ({ id: e.id, seg: e.seg, kind: e.kind, name: e.name, open: true }))
      },
      decisions: decisionCommands(sim),
      finalTick: sim.tick,
      summary: summary(sim),
      metrics: sim.metrics,
      alerts: sim.alerts
    };
  }

  return {
    CONSTANTS: C,
    createSim: createSim,
    apply: apply,
    step: step,
    replay: replay,
    seekTo: seekTo,
    segmentDetail: segmentDetail,
    exportPlan: exportPlan,
    decisionCommands: decisionCommands,
    exitDistances: exitDistances,
    formatClock: formatClock,
    dangerLevel: dangerLevel,
    computeWind: computeWind,
    clone: clone
  };
});
