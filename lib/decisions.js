// 决策操作、冲突校验、时间轴重放/分叉
import { CONFIG, createSessionState, step, encodeFrame } from './engine.js';

// 风机冲突检测：两台相距 <=8 段的在线风机风向对吹，中间形成气流停滞区
export function detectFanConflict(fans) {
  const online = fans.filter(f => f.online).sort((a, b) => a.index - b.index);
  const conflicts = [];
  for (let a = 0; a < online.length; a++) {
    for (let b = a + 1; b < online.length; b++) {
      const fa = online[a], fb = online[b];
      if (fb.index - fa.index > 8) break;
      if (fa.dir !== 0 && fb.dir !== 0 && fa.dir !== fb.dir) {
        const blowingToward = fa.index < fb.index && fa.dir === 1 && fb.dir === -1;
        if (blowingToward) {
          conflicts.push({
            type: 'fan_conflict',
            fans: [fa.index, fb.index],
            range: [fa.index, fb.index],
            reason: `${fa.index}#与${fb.index}#风机对吹，中间区段气流停滞、烟雾积聚`
          });
        }
      }
    }
  }
  return conflicts;
}

// 出口不可用影响
export function unavailableExitImpact(exits) {
  return exits.filter(e => !e.open).map(e => ({
    type: 'exit_unavailable', exit: e.id, segment: e.index,
    reason: `${e.label}不可用，附近人员需绕行至其他出口`
  }));
}

// 应用决策到实时状态；失败返回 { error }，调用方负责回滚
export function applyDecision(state, decision) {
  const warnings = [];
  switch (decision.action) {
    case 'setFan': {
      const fan = state.fans.find(f => f.index === decision.index);
      if (!fan) return { error: `风机 ${decision.index}# 不存在` };
      if (![-1, 0, 1].includes(decision.dir)) return { error: '风机方向非法' };
      fan.dir = decision.dir;
      fan.online = decision.dir !== 0;
      break;
    }
    case 'allFans': {
      if (![-1, 1].includes(decision.dir)) return { error: '风机方向非法' };
      state.fans.forEach(f => { f.dir = decision.dir; f.online = true; });
      break;
    }
    case 'toggleExit': {
      const ex = state.exits.find(e => e.id === decision.exitId);
      if (!ex) return { error: `出口 ${decision.exitId} 不存在` };
      ex.open = !!decision.open;
      break;
    }
    case 'extinguish': {
      state.fire.out = true;
      break;
    }
    default:
      break; // start/pause/step 为控制类，不改变物理状态
  }
  warnings.push(...detectFanConflict(state.fans), ...unavailableExitImpact(state.exits));
  return { warnings };
}

// 按时间轴重放到目标 tick（含），用于分叉与服务重启恢复
export function replayTo(setup, decisions, targetTick) {
  const state = createSessionState(setup);
  const history = [encodeFrame(state)];
  const eventLog = [];
  const sorted = [...decisions].sort((a, b) => a.tick - b.tick || (a.seq || 0) - (b.seq || 0));
  let di = 0;
  while (state.tick < targetTick && state.status !== 'done') {
    let mutated = false;
    while (di < sorted.length && sorted[di].tick <= state.tick) {
      const d = sorted[di];
      if (['setFan', 'allFans', 'toggleExit', 'extinguish'].includes(d.action)) {
        applyDecision(state, d);
        mutated = true;
      }
      di++;
    }
    if (mutated) history[history.length - 1] = encodeFrame(state);
    const out = step(state);
    history.push(encodeFrame(state));
    eventLog.push(...out.events);
  }
  // 决策锚定在“当前 tick”：到达目标 tick 后，仍需应用该 tick 上的决策并覆盖快照帧
  let mutated = false;
  while (di < sorted.length && sorted[di].tick <= state.tick) {
    const d = sorted[di];
    if (['setFan', 'allFans', 'toggleExit', 'extinguish'].includes(d.action)) {
      applyDecision(state, d);
      mutated = true;
    }
    di++;
  }
  if (mutated) history[history.length - 1] = encodeFrame(state);
  return { state, history, eventLog };
}
