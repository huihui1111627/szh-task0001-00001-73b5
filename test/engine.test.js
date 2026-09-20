'use strict';
const assert = require('assert');
const E = require('../public/sim/engine.js');
const C = E.CONSTANTS;

function runToEnd(sim, fanDirs) {
  if (fanDirs) sim.fans.forEach((f, i) => { if (fanDirs[i] != null) f.dir = fanDirs[i]; });
  E.apply(sim, { type: 'set_fire', seg: 12, level: 3 });
  E.apply(sim, { type: 'start' });
  let guard = 0;
  while (sim.status !== C.STATUS.FINISHED && guard++ < 700) E.step(sim);
  return sim;
}

// 1. 基础推演: 火灾产生烟雾/温度, 能见度下降
{
  const sim = E.createSim({ seed: 42, density: 'medium' });
  E.apply(sim, { type: 'set_fire', seg: 12, level: 2 });
  for (let i = 0; i < 20; i++) E.step(sim);
  assert(sim.segments[12].temp > 60, 'fire segment heats up');
  assert(sim.segments[12].visibility < C.VIS_MAX, 'visibility drops');
  const maxSmoke = Math.max(...sim.segments.map(s => s.smoke));
  assert(maxSmoke > 0.3, 'smoke spreads, max=' + maxSmoke);
  console.log('ok 1 烟雾/温度/能见度随时间变化');
}

// 2. 疏散: 所有人员最终为 evacuated 或 trapped
{
  const sim = runToEnd(E.createSim({ seed: 7, density: 'high' }));
  const total = sim.totals.initialPeople;
  assert(total > 0, 'people materialized');
  const decided = sim.people.filter(p => p.state === 'evacuated' || p.state === 'trapped').length;
  assert.strictEqual(decided, total, 'all decided');
  assert(sim.totals.evacuated > total * 0.8, 'most evacuate: ' + sim.totals.evacuated + '/' + total);
  console.log('ok 2 疏散完成', sim.totals.evacuated + '/' + total, '撤离,', sim.totals.trapped, '被困, 用时', E.formatClock(sim.tick * C.TICK_SECONDS));
}

// 3. 风机影响烟流方向: 向东送风时下游烟雾更多
{
  const mk = () => E.createSim({ seed: 99, density: 'low' });
  const a = mk(); E.apply(a, { type: 'set_fire', seg: 12, level: 3 });
  const b = mk(); E.apply(b, { type: 'set_fire', seg: 12, level: 3 });
  a.fans.forEach(f => f.dir = 1);
  b.fans.forEach(f => f.dir = -1);
  for (let i = 0; i < 25; i++) { E.computeWind(a); E.step(a); E.computeWind(b); E.step(b); }
  const smokeDownA = a.segments.slice(13, 19).reduce((x, s) => x + s.smoke, 0);
  const smokeDownB = b.segments.slice(13, 19).reduce((x, s) => x + s.smoke, 0);
  assert(smokeDownA > smokeDownB, 'east fan pushes smoke east');
  console.log('ok 3 风机方向影响烟雾蔓延');
}

// 4. 风机冲突告警
{
  const sim = E.createSim({ seed: 5, density: 'low' });
  E.apply(sim, { type: 'set_fire', seg: 12, level: 1 });
  E.apply(sim, { type: 'set_fan', fanId: sim.fans[0].id, dir: 1 });
  E.apply(sim, { type: 'set_fan', fanId: sim.fans[1].id, dir: -1 });
  assert(sim.alerts.some(a => a.type === C.ALERT_TYPES.FAN_CONFLICT), 'conflict detected');
  console.log('ok 4 风机对射冲突告警');
}

// 5. 出口关闭 + 硬失败保护
{
  const sim = E.createSim({ seed: 5, density: 'low' });
  E.apply(sim, { type: 'set_fire', seg: 10, level: 2 });
  sim.exits.filter(e => e.kind === 'cross').forEach(e => E.apply(sim, { type: 'toggle_exit', exitId: e.id, open: false }));
  E.apply(sim, { type: 'toggle_exit', exitId: 'PE', open: false });
  assert(sim.alerts.some(a => a.type === C.ALERT_TYPES.EXIT_BLOCKED), 'exit blocked alert');
  // 此时仅剩 PW, 关闭它会让火区无路 => 硬失败
  const r = E.apply(sim, { type: 'toggle_exit', exitId: 'PW', open: false });
  assert(!r.ok, 'closing last exit rejected: ' + r.error);
  assert(sim.exits.find(e => e.id === 'PW').open, 'PW still open after failed op');
  console.log('ok 5 出口不可用告警与操作拒绝');
}

// 6. 操作失败回滚: 失败命令不改变状态
{
  const sim = E.createSim({ seed: 5, density: 'medium' });
  const snap = JSON.stringify(sim);
  const r = E.apply(sim, { type: 'set_fire', seg: 99, level: 3 });
  assert(!r.ok);
  assert.strictEqual(JSON.stringify(sim), snap, 'state unchanged on failure');
  console.log('ok 6 失败操作不污染状态 (可回滚)');
}

// 7. 重放确定性 + seekTo
{
  const sim = runToEnd(E.createSim({ seed: 123, density: 'jam' }));
  const plan = E.exportPlan(sim, 'A');
  const rep = E.replay(plan.config, plan.decisions, plan.finalTick);
  const orig = sim.metrics.map(m => m.evacuated + ':' + m.trapped).join('|');
  const again = rep.metrics.map(m => m.evacuated + ':' + m.trapped).join('|');
  assert.strictEqual(again, orig, 'replay determinism');
  const r = E.seekTo(sim, 10);
  assert(r.ok && r.sim.tick === 10, 'seek to tick 10');
  assert(r.sim.timeline.some(e => e.kind === 'branch'), 'branch marker');
  console.log('ok 7 重放确定性 + 时间节点分支恢复');
}

// 8. 交通密度影响人数
{
  const lo = E.createSim({ seed: 1, density: 'low' });
  const hi = E.createSim({ seed: 1, density: 'jam' });
  const vLo = lo.segments.reduce((x, s) => x + s.vehicles.length, 0);
  const vHi = hi.segments.reduce((x, s) => x + s.vehicles.length, 0);
  assert(vHi > vLo * 2, 'jam denser than low');
  console.log('ok 8 交通密度生效', vLo, 'vs', vHi, '辆车');
}

console.log('\n全部测试通过');
