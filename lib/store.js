// 会话（处置方案）存储：内存运行态 + JSON 原子持久化 + 事件溯源恢复
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG, createSessionState, step, encodeFrame } from './engine.js';
import { applyDecision, replayTo, detectFanConflict, unavailableExitImpact } from './decisions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'sessions');
const TICK_INTERVAL_MS = 500;

const clone = o => JSON.parse(JSON.stringify(o));

class Session {
  constructor(meta) {
    Object.assign(this, meta);   // id,name,setup,decisions,frames,...
    this.eventLog = meta.eventLog || [];
    this.state = null;
    this.timer = null;
    this.listeners = new Set();
    this._saveTimer = null;
    this._seq = Math.max(0, ...this.decisions.map(d => d.seq || 0));
  }

  // 从持久化记录恢复运行态：优先事件重放，保证物理状态与时间轴一致
  hydrate() {
    const targetTick = this.currentTick ?? 0;
    const { state, history, eventLog } = replayTo(this.setup, this.decisions, targetTick);
    state.status = this.status === 'done' ? 'done' : (this.phaseStatus || 'paused');
    this.state = state;
    this.frames = history;
    this.eventLog = eventLog;
    return this;
  }

  toJSON() {
    return {
      id: this.id, name: this.name, setup: this.setup,
      decisions: this.decisions, frames: this.frames,
      currentTick: this.state ? this.state.tick : this.currentTick,
      status: this.liveStatus || this.status,
      savedAt: Date.now()
    };
  }

  get liveStatus() {
    return this.state ? (this.timer ? 'running' : this.state.status === 'done' ? 'done' : 'paused') : this.status;
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(evt) { for (const fn of this.listeners) { try { fn(evt); } catch { /* 忽略坏连接 */ } } }

  scheduleSave(immediate = false) {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    if (immediate) { this._saveTimer = null; return store.flush(this); }
    this._saveTimer = setTimeout(() => { this._saveTimer = null; store.flush(this); }, 800);
  }

  start() {
    if (!this.state) this.hydrate();
    if (this.state.status === 'done') return { error: '推演已完成，请新建方案或从时间轴分叉' };
    if (this.timer) return { error: '推演已在运行中' };
    this.state.status = 'running';
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.emit({ type: 'status', status: 'running' });
    this.scheduleSave(true);
    return { ok: true };
  }

  pause() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.state && this.state.status !== 'done') this.state.status = 'paused';
    this.emit({ type: 'status', status: 'paused' });
    this.scheduleSave(true);
    return { ok: true };
  }

  singleStep() {
    if (!this.state) this.hydrate();
    if (this.timer) return { error: '运行中不能单步，请先暂停' };
    if (this.state.status === 'done') return { error: '推演已完成' };
    const out = this.tick();
    this.state.status = 'paused';
    this.scheduleSave(true);
    return out;
  }

  tick() {
    if (!this.state) this.hydrate();
    const before = clone(this.state);
    try {
      const { events } = step(this.state);
      this.frames.push(encodeFrame(this.state));
      // 物理决策（风机/出口）在时间轴上以“当前 tick”锚定，重放时可精确复原
      this.scheduleSave();
      const warnings = [
        ...detectFanConflict(this.state.fans),
        ...unavailableExitImpact(this.state.exits)
      ];
      const payload = { type: 'tick', frame: this.frames[this.frames.length - 1], events, warnings };
      this.emit(payload);
      if (this.state.status === 'done') {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this.emit({ type: 'status', status: 'done' });
        this.scheduleSave(true);
      }
      return payload;
      for (const ev of events) this.eventLog.push(ev);
    } catch (err) {
      // 操作失败回到最近一次有效状态
      this.state = before;
      this.emit({ type: 'error', message: String(err && err.message || err) });
      return { error: String(err && err.message || err) };
    }
  }

  // 执行物理决策；先校验+快照，失败整体回滚（状态与时间轴都回到最近有效点）
  decide(action, params = {}) {
    if (!this.state) this.hydrate();
    const snapshotState = clone(this.state);
    const snapshotDecisions = clone(this.decisions);
    const decision = {
      id: `d${++this._seq}`,
      seq: this._seq,
      action,
      tick: this.state.tick,
      at: Date.now(),
      ...params
    };
    try {
      const res = applyDecision(this.state, decision);
      if (res.error) {
        this.state = snapshotState;
        this.decisions = snapshotDecisions;
        this._seq = Math.max(0, ...this.decisions.map(d => d.seq || 0));
        return { error: res.error, rolledBack: true };
      }
      this.decisions.push(decision);
      const frame = encodeFrame(this.state);
      // 决策帧：覆盖当前 tick 的快照（风机方向立即生效，下一 tick 开始影响烟流）
      this.frames[this.frames.length - 1] = frame;
      this.scheduleSave(true);
      this.emit({ type: 'decision', decision, warnings: res.warnings, frame });
      return { ok: true, decision, warnings: res.warnings };
    } catch (err) {
      this.state = snapshotState;
      this.decisions = snapshotDecisions;
      return { error: String(err && err.message || err), rolledBack: true };
    }
  }

  // 从指定时间节点（tick）分叉出新方案：保留之前的决策，丢弃其后时间轴
  branchAt(tick, name) {
    tick = Math.max(0, Math.min(tick, this.frames.length - 1));
    const kept = this.decisions.filter(d => d.tick <= tick);
    return store.create({
      name: name || `${this.name}@${formatTick(tick)}`,
      setup: this.setup,
      decisions: kept,
      branchFrom: this.id,
      branchAtTick: tick
    });
  }

  // 在当前方案内回退到某时间节点（不可逆地截断后续时间轴）
  seekTo(tick) {
    this.pause();
    tick = Math.max(0, Math.min(tick, this.frames.length - 1));
    const kept = this.decisions.filter(d => d.tick <= tick);
    const { state, history } = replayTo(this.setup, kept, tick);
    state.status = 'paused';
    this.state = state;
    this.frames = history;
    this.decisions = kept;
    this.scheduleSave(true);
    this.emit({ type: 'seek', tick });
    return { ok: true, tick };
  }

  snapshot() {
    if (!this.state) this.hydrate();
    return {
      id: this.id, name: this.name, setup: this.setup,
      status: this.liveStatus,
      frame: this.frames[this.frames.length - 1],
      tick: this.state.tick,
      fire: this.state.fire,
      fans: this.state.fans,
      exits: this.state.exits,
      decisions: this.decisions,
      frameCount: this.frames.length,
      affectedPeople: this.state.affectedPeople ?? 0,
      remainingPeople: this.state.remainingPeople ?? 0,
      evacuated: this.state.evacuated,
      casualties: this.state.casualties,
      etaTicks: this.state.etaTicks ?? null,
      branchFrom: this.branchFrom || null,
      warnings: [
        ...detectFanConflict(this.state.fans),
        ...unavailableExitImpact(this.state.exits)
      ],
      recentEvents: this.recentEvents()
    };
  }

  recentEvents() {
    const t = this.state ? this.state.tick : 0;
    return this.eventLog.filter(e => e.tick >= t - 10).slice(-30);
  }
}

export function formatTick(tick) {
  const total = tick * (CONFIG.TICK_MS / 1000);
  const m = Math.floor(total / 60), s = Math.round(total % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

class StoreClass {
  constructor() {
    this.sessions = new Map();
    this.flushing = new Set();
  }

  async init() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const files = await fs.readdir(DATA_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(DATA_DIR, f), 'utf8'));
        const session = new Session({
          id: raw.id, name: raw.name, setup: raw.setup,
          decisions: raw.decisions || [], frames: raw.frames || [],
          currentTick: raw.currentTick || 0, status: raw.status || 'paused',
          eventLog: raw.eventLog || [],
          branchFrom: raw.branchFrom || null, branchAtTick: raw.branchAtTick ?? null
        });
        session.hydrate(); // 启动时事件重放恢复未完成推演（始终以暂停态恢复）
        this.sessions.set(session.id, session);
      } catch (err) {
        console.error(`恢复会话文件失败 ${f}:`, err.message);
      }
    }
  }

  create({ name, setup, decisions = [], branchFrom = null, branchAtTick = null, currentTick = 0 }) {
    const id = 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    const session = new Session({
      id, name: name || `方案 ${this.sessions.size + 1}`,
      setup, decisions, frames: [],
      currentTick: branchAtTick ?? currentTick,
      status: branchAtTick != null ? 'paused' : 'ready',
      eventLog: [], branchFrom, branchAtTick
    });
    session.hydrate();
    this.sessions.set(id, session);
    session.scheduleSave(true);
    return session;
  }

  get(id) { return this.sessions.get(id); }
  list() {
    return [...this.sessions.values()].map(s => ({
      id: s.id, name: s.name, status: s.liveStatus,
      tick: s.state ? s.state.tick : s.currentTick,
      setup: s.setup,
      evacuated: s.state ? s.state.evacuated : 0,
      remainingPeople: s.state ? (s.state.remainingPeople ?? 0) : 0,
      casualties: s.state ? s.state.casualties : 0,
      branchFrom: s.branchFrom || null,
      savedAt: s.savedAt || null
    }));
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.timer) clearInterval(s.timer);
    this.sessions.delete(id);
    fs.unlink(path.join(DATA_DIR, `${id}.json`)).catch(() => {});
    return true;
  }

  async flush(session) {
    if (this.flushing.has(session.id)) return;
    this.flushing.add(session.id);
    try {
      const tmp = path.join(DATA_DIR, `${session.id}.tmp`);
      const dst = path.join(DATA_DIR, `${session.id}.json`);
      await fs.writeFile(tmp, JSON.stringify(session.toJSON()));
      await fs.rename(tmp, dst); // 原子替换，避免写一半崩溃损坏存档
      session.savedAt = Date.now();
    } catch (err) {
      console.error('持久化失败:', err.message);
    } finally {
      this.flushing.delete(session.id);
    }
  }

  async flushAll() {
    await Promise.all([...this.sessions.values()].map(s => {
      if (s.timer) s.pause();
      return this.flush(s);
    }));
  }
}

export const store = new StoreClass();
