// 隧道通风与火灾疏散推演引擎（纯函数式 tick 计算，无 IO 依赖）

export const CONFIG = {
  SEGMENTS: 24,              // 隧道区段数（每段 100m）
  SEGMENT_LENGTH_M: 100,
  TICK_MS: 2000,             // 一个推演步 = 2 秒现实时间
  MAX_TICKS: 1800,           // 最长推演 60 分钟（现实时间）
  WIND_SPEED_PER_FAN: 1.2,   // 单台射流风机贡献 m/s
  FAN_INDICES: [2, 6, 10, 14, 18, 22],
  EXITS: [
    { id: 'W', index: 0, label: '西洞口' },
    { id: 'E', index: 23, label: '东洞口' },
    { id: 'M1', index: 7, label: '1#横通道' },
    { id: 'M2', index: 16, label: '2#横通道' }
  ],
  AMBIENT_TEMP: 20,
  LETHAL_TEMP: 60,           // >=60C 视为致命温度
  DANGER_TEMP: 45,           // >=45C 危险
  SMOKE_BLOCK: 0.55,         // 烟雾浓度阈值，超过则路径阻断
  VIS_BLOCK_M: 8,            // 能见度低于 8m 路径阻断
  EVAC_SPEED: 1.2,           // 人员步行速度 m/s（良好环境）
  EXIT_FLOW_PER_TICK: 8,     // 每 tick 单个出口通过人数
  DIFFUSION: 0.05,           // 烟雾/热量紊流扩散系数
  COOLING: 0.02,             // 每 tick 向环境散热比例
  MAX_PEOPLE_PER_SEG: 60
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 火灾强度参数：每 tick 产烟/产热（按等级）
const FIRE_PARAMS = {
  1: { smoke: 0.10, heat: 4.0, peakTemp: 70 },
  2: { smoke: 0.20, heat: 8.0, peakTemp: 140 },
  3: { smoke: 0.34, heat: 13.0, peakTemp: 260 }
};

export function fireParams(level) {
  return FIRE_PARAMS[clamp(level, 1, 3)] || FIRE_PARAMS[2];
}

// ---------- 初始化推演状态 ----------
export function createSessionState({ fireSegment, fireLevel, trafficDensity, seed = Date.now() }) {
  const N = CONFIG.SEGMENTS;
  const rng = mulberry32(seed);
  fireSegment = clamp(Math.round(fireSegment), 0, N - 1);
  fireLevel = clamp(Math.round(fireLevel), 1, 3);
  trafficDensity = clamp(trafficDensity, 0, 1);

  const fans = CONFIG.FAN_INDICES.map(index => ({ index, dir: 1, online: true }));
  const exits = CONFIG.EXITS.map(e => ({ ...e, open: true }));

  // 车辆数：密度 0~1 -> 每段 0~24 辆；起火段车辆较少（部分已驶离）
  const vehicles = Array.from({ length: N }, (_, i) => {
    const base = Math.round(trafficDensity * 24 * (0.55 + rng() * 0.9));
    return i === fireSegment ? Math.round(base * 0.3) : base;
  });

  // 初始受影响人员：每车约 2.2 人，叠加少量工作人员
  const people = vehicles.map((v, i) =>
    Math.round(v * 2.2 + (i % 6 === 0 ? 3 : 0)));

  const smoke = new Array(N).fill(0);
  const temp = new Array(N).fill(CONFIG.AMBIENT_TEMP);
  const visibility = new Array(N).fill(50); // 能见度（米）

  return {
    tick: 0,
    fire: { segment: fireSegment, level: fireLevel, ignited: false, out: false },
    trafficDensity,
    vehicles,
    people,
    evacuated: 0,
    casualties: 0,
    smoke,
    temp,
    visibility,
    wind: new Array(N).fill(0),
    fans,
    exits,
    events: [],
    status: 'ready',            // ready | running | paused | done
    startTick: null,            // 起火在第几个 tick 被点燃
    seed: seed >>> 0
  };
}

// ---------- 气流场：射流风机向相邻区段扩散，叠加自然风 ----------
function computeWind(fans, tick) {
  const N = CONFIG.SEGMENTS;
  const raw = new Array(N).fill(0);
  for (const f of fans) {
    if (!f.online) continue;
    raw[f.index] += f.dir * CONFIG.WIND_SPEED_PER_FAN;
  }
  // 沿隧道线性扩散：每个风机影响前后 4 个区段
  const wind = new Array(N).fill(0);
  for (const f of fans) {
    if (!f.online) continue;
    for (let d = -4; d <= 4; d++) {
      const i = f.index + d;
      if (i < 0 || i >= N) continue;
      const falloff = 1 - Math.abs(d) / 5;
      wind[i] += f.dir * CONFIG.WIND_SPEED_PER_FAN * falloff;
    }
  }
  // 自然活塞风：微弱向东，叠加由 tick 决定的缓慢阵风（确定性，重放可复现）
  const gust = 0.06 * Math.sin((tick || 0) * 0.07);
  for (let i = 0; i < N; i++) wind[i] += 0.12 + gust * (0.4 + 0.6 * i / N);
  return wind.map(v => clamp(v, -3.5, 3.5));
}

// 半拉格朗日上风平流（烟雾/温度通用），返回新数组
function advect(field, wind, opts) {
  const N = field.length;
  const next = new Array(N).fill(0);
  const ambient = opts.ambient ?? 0;
  const diff = opts.diffusion ?? CONFIG.DIFFUSION;
  const decay = opts.decay ?? 0; // 每 tick 沉降/消散比例
  for (let i = 0; i < N; i++) {
    // 一个 tick(2s) 内移动的区段数：speed*2/100
    const shift = (wind[i] * (CONFIG.TICK_MS / 1000)) / CONFIG.SEGMENT_LENGTH_M;
    const src = i - shift; // 上风源位置
    const lo = Math.floor(src), hi = lo + 1;
    const frac = src - lo;
    let v;
    if (lo < 0) v = ambient;
    else if (hi >= N) v = ambient;
    else v = (field[lo] ?? ambient) * (1 - frac) + (field[hi] ?? ambient) * frac;
    // 紊流逆扩散
    if (i > 0) v += (field[i - 1] - v) * diff * 0.5;
    if (i < N - 1) v += (field[i + 1] - v) * diff * 0.5;
    // 向环境回归（烟雾沉降 / 散热的一部分）
    v -= (v - ambient) * decay;
    next[i] = opts.clamp ? clamp(v, ambient < 0 ? -1e9 : 0, opts.clamp) : v;
  }
  return next;
}

function visibilityFromSmoke(s) {
  if (s <= 0.01) return 50;
  return clamp(3.0 / Math.max(s, 0.02) * 3, 1.0, 50); // 浓度越高能见度越低
}

// ---------- 疏散：从所有可用出口反向 BFS，计算各区段最近出口 ----------
function computeEscapePlan(state) {
  const N = CONFIG.SEGMENTS;
  const blocked = new Array(N).fill(false);
  const blockedReason = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    if (state.temp[i] >= CONFIG.LETHAL_TEMP) { blocked[i] = true; blockedReason[i] = '高温致命'; }
    else if (state.smoke[i] >= CONFIG.SMOKE_BLOCK) { blocked[i] = true; blockedReason[i] = '浓烟阻断'; }
    else if (state.visibility[i] <= CONFIG.VIS_BLOCK_M) { blocked[i] = true; blockedReason[i] = '能见度不足'; }
  }
  const dist = new Array(N).fill(Infinity);
  const next = new Array(N).fill(-1);
  const exitId = new Array(N).fill(null);
  const queue = [];
  for (const e of state.exits) {
    if (!e.open) continue;
    if (blocked[e.index]) continue;
    dist[e.index] = 0; exitId[e.index] = e.id; queue.push(e.index);
  }
  while (queue.length) {
    const i = queue.shift();
    for (const d of [-1, 1]) {
      const j = i + d;
      if (j < 0 || j >= N || blocked[j]) continue;
      const nd = dist[i] + CONFIG.SEGMENT_LENGTH_M;
      if (nd < dist[j]) {
        dist[j] = nd; next[j] = i; exitId[j] = exitId[i];
        queue.push(j);
      }
    }
  }
  return { blocked, blockedReason, dist, next, exitId };
}

function evacuateStep(state, plan, events) {
  const N = CONFIG.SEGMENTS;
  const remaining = state.people.map(p => p);
  let evacuated = state.evacuated;
  let casualties = state.casualties;
  const incoming = new Array(N).fill(0);

  for (let i = 0; i < N; i++) {
    let p = remaining[i];
    if (p <= 0) continue;

    // 暴露在危险环境：减员
    if (state.temp[i] >= CONFIG.LETHAL_TEMP) {
      const lost = p * 0.4;
      casualties += lost; p -= lost;
      if (lost >= 0.5) events.push({ tick: state.tick, type: 'casualty', segment: i, reason: '高温致命', count: round1(lost) });
    } else if (state.smoke[i] >= 0.8) {
      const lost = p * 0.06;
      casualties += lost; p -= lost;
    }

    if (p <= 0) { remaining[i] = 0; continue; }

    // 出口在本段：按出口通行能力撤离
    const atExit = state.exits.find(e => e.open && e.index === i);
    if (atExit) {
      const out = Math.min(p, CONFIG.EXIT_FLOW_PER_TICK);
      evacuated += out; p -= out;
    }

    if (p <= 0) { remaining[i] = 0; continue; }

    if (plan.next[i] >= 0) {
      // 移动速度随能见度下降；高温区速度减半
      let speed = CONFIG.EVAC_SPEED;
      if (state.visibility[i] < 20) speed *= clamp(state.visibility[i] / 20, 0.35, 1);
      if (state.temp[i] >= CONFIG.DANGER_TEMP) speed *= 0.5;
      const frac = clamp((speed * (CONFIG.TICK_MS / 1000)) / CONFIG.SEGMENT_LENGTH_M, 0, 1);
      const movers = p * frac;
      incoming[plan.next[i]] += movers;
      p -= movers;
    }
    remaining[i] = p;
  }
  for (let i = 0; i < N; i++) remaining[i] += incoming[i];

  const trappedSegments = [];
  for (let i = 0; i < N; i++) {
    if (remaining[i] >= 1 && plan.dist[i] === Infinity) {
      trappedSegments.push(i);
    }
  }
  return { people: remaining.map(round1), evacuated: round1(evacuated), casualties: round1(casualties), trappedSegments };
}

const round1 = v => Math.round(v * 10) / 10;

// ---------- 主推演步 ----------
export function step(state) {
  const events = [];
  const N = CONFIG.SEGMENTS;
  state.tick += 1;

  // 首个 tick 点燃火灾
  if (!state.fire.ignited) {
    state.fire.ignited = true;
    state.startTick = state.tick;
    events.push({ tick: state.tick, type: 'ignition', segment: state.fire.segment, level: state.fire.level });
  }

  const fp = fireParams(state.fire.level);
  state.wind = computeWind(state.fans, state.tick);

  // 火源产烟/产热
  const fs = state.fire.segment;
  if (!state.fire.out) {
    state.smoke[fs] = clamp(state.smoke[fs] + fp.smoke, 0, 1);
    state.temp[fs] = clamp(state.temp[fs] + fp.heat, CONFIG.AMBIENT_TEMP, fp.peakTemp);
  }

  // 烟雾与热量平流
  state.smoke = advect(state.smoke, state.wind, { ambient: 0, clamp: 1, diffusion: CONFIG.DIFFUSION, decay: 0.015 });
  state.temp = advect(state.temp, state.wind, {
    ambient: CONFIG.AMBIENT_TEMP, clamp: 300, diffusion: CONFIG.DIFFUSION * 0.6
  }).map(t => {
    // 向环境散热
    const cooled = t - (t - CONFIG.AMBIENT_TEMP) * CONFIG.COOLING;
    if (!state.fire.out) {
      // 火源附近热辐射
      for (let d = 1; d <= 2; d++) {
        if (fs - d >= 0 || fs + d < N) { /* 邻段热量已由平流携带 */ }
      }
    }
    return cooled;
  });

  state.visibility = state.smoke.map(visibilityFromSmoke);

  // 人员疏散
  const plan = computeEscapePlan(state);
  const res = evacuateStep(state, plan, events);
  state.people = res.people;
  state.evacuated = res.evacuated;
  state.casualties = res.casualties;

  // 被困事件（同一区段每 15 tick 最多报一次，去重）
  for (const seg of res.trappedSegments) {
    if ((!state._lastTrappedAt || !state._lastTrappedAt[seg] ||
        state.tick - state._lastTrappedAt[seg] >= 15) && state.people[seg] >= 0.5) {
      events.push({
        tick: state.tick, type: 'trapped', segment: seg,
        reason: plan.blockedReason[seg] || '出口不可达',
        count: Math.round(state.people[seg])
      });
      state._lastTrappedAt = state._lastTrappedAt || {};
      state._lastTrappedAt[seg] = state.tick;
    }
  }

  const totalPeople = state.people.reduce((a, b) => a + b, 0);
  state.trappedSegments = res.trappedSegments;
  state.affectedPeople = Math.round(totalPeople + state.casualties);
  state.remainingPeople = Math.round(totalPeople);

  // 完成判定：剩余人员 < 1，或推演达到上限
  if (totalPeople < 1) {
    state.status = 'done';
    events.push({ tick: state.tick, type: 'complete', reason: '全部人员撤离' });
  } else if (state.tick >= CONFIG.MAX_TICKS) {
    state.status = 'done';
    events.push({ tick: state.tick, type: 'complete', reason: '达到最大推演时长' });
  }

  // 预计完成时间（按当前撤离速率线性外推，秒）
  if (state.evacuated > 0 && state.startTick !== null) {
    const elapsedTicks = state.tick - state.startTick;
    const rate = state.evacuated / Math.max(elapsedTicks, 1); // 人/tick
    state.etaTicks = rate > 0 ? state.tick + Math.ceil(totalPeople / rate) : null;
  }

  state.events = events;
  return { state, plan, events };
}

// ---------- 紧凑历史帧（用于回放/对比/持久化） ----------
export function encodeFrame(state) {
  return [
    state.tick,
    state.smoke.map(v => Math.round(v * 100)),
    state.temp.map(v => Math.round(v)),
    state.visibility.map(v => Math.round(v)),
    state.people.map(v => Math.round(v)),
    state.vehicles,
    state.wind.map(v => Math.round(v * 10)),
    Math.round(state.evacuated),
    Math.round(state.casualties),
    state.status,
    state.fans.map(f => (f.online ? f.dir : 0)),
    state.exits.map(e => (e.open ? 1 : 0)),
    state.trappedSegments || []
  ];
}

export const FRAME_FIELDS = {
  tick: 0, smoke: 1, temp: 2, visibility: 3, people: 4, vehicles: 5, wind: 6,
  evacuated: 7, casualties: 8, status: 9, fanDirs: 10, exitOpen: 11, trapped: 12
};
