// 核心推演逻辑冒烟测试：node tests/engine.test.js
import assert from 'node:assert';
import { createSessionState, step, CONFIG, encodeFrame, FRAME_FIELDS } from '../lib/engine.js';
import { applyDecision, detectFanConflict, replayTo } from '../lib/decisions.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

test('初始化：车辆与人员随交通密度增长', () => {
  const low = createSessionState({ fireSegment: 12, fireLevel: 2, trafficDensity: 0, seed: 1 });
  const high = createSessionState({ fireSegment: 12, fireLevel: 2, trafficDensity: 1, seed: 1 });
  const sum = a => a.reduce((x, y) => x + y, 0);
  assert.ok(sum(high.vehicles) > sum(low.vehicles));
  assert.ok(sum(high.people) > 0);
});

test('推进后火源处产生烟雾与温升', () => {
  const s = createSessionState({ fireSegment: 12, fireLevel: 2, trafficDensity: 0.3, seed: 7 });
  step(s);
  assert.ok(s.smoke[12] > 0, '火源段有烟');
  assert.ok(s.temp[12] > CONFIG.AMBIENT_TEMP, '火源段升温');
  assert.equal(s.fire.ignited, true);
});

test('风机向东时烟雾整体向东偏移更多', () => {
  const mk = dir => {
    const s = createSessionState({ fireSegment: 12, fireLevel: 2, trafficDensity: 0, seed: 3 });
    s.fans.forEach(f => { f.dir = dir; f.online = true; });
    for (let i = 0; i < 20; i++) step(s);
    const centroid = s.smoke.reduce((a, v, i) => a + v * i, 0) / s.smoke.reduce((a, b) => a + b, 0);
    return centroid;
  };
  const east = mk(1), west = mk(-1);
  assert.ok(east > west, `东风水烟雾质心(${east}) 应在西风(${west})东侧`);
});

test('对吹风机被检测为冲突并给出影响范围', () => {
  const s = createSessionState({ fireSegment: 12, fireLevel: 2, trafficDensity: 0, seed: 1 });
  s.fans.forEach(f => { f.dir = 1; f.online = true; });
  assert.equal(detectFanConflict(s.fans).length, 0);
  const r = applyDecision(s, { action: 'setFan', index: 18, dir: -1 });
  const conflicts = r.warnings.filter(w => w.type === 'fan_conflict');
  assert.ok(conflicts.length >= 2, '应同时与 10#/14# 形成对吹');
  assert.ok(conflicts.some(c => c.range[0] === 14 && c.range[1] === 18));
});

test('封闭所有出口会导致人员被困', () => {
  const s = createSessionState({ fireSegment: 12, fireLevel: 3, trafficDensity: 0.8, seed: 5 });
  s.exits.forEach(e => { e.open = false; });
  for (let i = 0; i < 5; i++) step(s);
  const remaining = s.people.reduce((a, b) => a + b, 0);
  assert.ok(remaining > 0, '无人撤离');
  assert.equal(s.evacuated, 0);
});

test('默认场景下人员随时间逐步撤离', () => {
  const s = createSessionState({ fireSegment: 12, fireLevel: 1, trafficDensity: 0.3, seed: 9 });
  for (let i = 0; i < 400 && s.status !== 'done'; i++) step(s);
  assert.ok(s.evacuated > 0, '应有人员撤离');
});

test('事件重放与实时推进结果一致（断点恢复）', () => {
  const setup = { fireSegment: 10, fireLevel: 2, trafficDensity: 0.5, seed: 42 };
  const live = createSessionState(setup);
  const decisions = [];
  let seq = 0;
  for (let t = 1; t <= 30; t++) {
    step(live);
    if (t === 10) {
      const d = { action: 'setFan', index: 14, dir: -1, tick: live.tick, seq: ++seq };
      applyDecision(live, d); decisions.push(d);
    }
    if (t === 20) {
      const d = { action: 'toggleExit', exitId: 'M1', open: false, tick: live.tick, seq: ++seq };
      applyDecision(live, d); decisions.push(d);
    }
  }
  const { state } = replayTo(setup, decisions, 30);
  assert.deepEqual(state.smoke.map(v => Math.round(v * 1e5)),
    live.smoke.map(v => Math.round(v * 1e5)));
  assert.deepEqual(state.temp.map(v => Math.round(v * 100)),
    live.temp.map(v => Math.round(v * 100)));
  assert.deepEqual(state.people.map(v => Math.round(v * 10)),
    live.people.map(v => Math.round(v * 10)));
});

test('非法决策被拒绝且不改变风机状态', () => {
  const s = createSessionState({ fireSegment: 12, fireLevel: 2, trafficDensity: 0, seed: 1 });
  const before = s.fans[0].dir;
  const r = applyDecision(s, { action: 'setFan', index: 99, dir: 1 });
  assert.ok(r.error);
  assert.equal(s.fans[0].dir, before);
});

test('紧凑帧包含全部 13 个字段且可还原', () => {
  const s = createSessionState({ fireSegment: 12, fireLevel: 2, trafficDensity: 0.5, seed: 1 });
  step(s);
  const f = encodeFrame(s);
  assert.equal(f.length, 13);
  assert.equal(f[FRAME_FIELDS.tick], 1);
  assert.equal(f[FRAME_FIELDS.fanDirs].length, CONFIG.FAN_INDICES.length);
});


test('恢复重放：目标 tick 上的决策在恢复后仍生效', () => {
  const setup = { fireSegment: 12, fireLevel: 2, trafficDensity: 0.3, seed: 11 };
  const decisions = [{ action: 'setFan', index: 10, dir: -1, tick: 20, seq: 1 }];
  const { state } = replayTo(setup, decisions, 20);
  const fan10 = state.fans.find(f => f.index === 10);
  assert.equal(fan10.dir, -1);
  assert.equal(fan10.online, true);
  assert.equal(state.tick, 20);
});

test('恢复重放：从分叉节点恢复只保留此前决策', () => {
  const setup = { fireSegment: 12, fireLevel: 2, trafficDensity: 0.3, seed: 11 };
  const decisions = [
    { action: 'setFan', index: 6, dir: -1, tick: 5, seq: 1 },
    { action: 'setFan', index: 10, dir: -1, tick: 15, seq: 2 }
  ];
  const { state } = replayTo(setup, decisions.filter(d => d.tick <= 12), 12);
  assert.equal(state.fans.find(f => f.index === 6).dir, -1);
  assert.equal(state.fans.find(f => f.index === 10).dir, 1);
  assert.equal(state.tick, 12);
});

console.log(`\n全部 ${passed} 项测试通过`);
