'use strict';

/**
 * 隧道火灾推演 - 全局常量
 * 单位约定:
 *   长度 m, 时间 tick = 10s, 速度 m/tick, 烟雾 0..1 相对浓度, 温度 °C, 能见度 m
 */
const CONSTANTS = Object.freeze({
  SEGMENT_LENGTH: 50,
  SEGMENT_COUNT: 24,
  LANE_COUNT: 2,
  TICK_SECONDS: 10,
  MAX_TICKS: 600,

  // 烟雾/热量输运
  ADVECTION_RATE: 0.30,        // 顺流输运比例 / tick
  ADVECTION_UPSTREAM: 0.05,    // 逆流渗透比例
  DIFFUSION_RATE: 0.10,        // 双向扩散比例
  SMOKE_DECAY: 0.015,          // 自然沉降
  DIFFUSION_HEAT: 0.12,
  HEAT_LOSS: 0.025,
  AMBIENT_TEMP: 20,

  // 火灾烟雾释放 (按等级)
  FIRE_EMIT: { 1: 0.05, 2: 0.12, 3: 0.22 },
  FIRE_HEAT: { 1: 14, 2: 40, 3: 90 },
  FIRE_DURATION: { 1: 60, 2: 120, 3: 180 }, // ticks

  // 能见度 (m): vis = MAX / (1 + k*smoke)
  VIS_MAX: 30,
  VIS_K: 12,

  // 危险阈值
  TEMP_DANGER: 60,
  TEMP_LETHAL: 100,
  VIS_DANGER: 10,
  SMOKE_DANGER: 0.35,

  // 人员
  WALK_SPEED: 1.2,             // m/s 基础步行速度 => 12 m/tick
  WALK_TEMP_FACTOR: 0.5,       // 高温减速系数
  WALK_SMOKE_FACTOR: 0.45,     // 低能见度减速系数
  OCCUPANTS_PER_VEHICLE: 2.4,
  TRUCK_RATIO: 0.12,
  TRUCK_OCCUPANTS: 1.2,

  // 风机
  FAN_THRUST: 0.55,            // 对相邻区段风速的推力 m/tick
  FAN_RANGE: 2,                // 推力影响半径 (区段数)
  FAN_CONFLICT_GAP: 4,         // 相邻对射风机间距 <= 该值判定冲突
  AMBIENT_WIND: 0.02,          // 自然风 m/tick (+: 洞口 0 -> N-1)

  // 交通密度 -> 每车道每区段车辆数
  TRAFFIC_PER_CELL: { low: 0.35, medium: 0.8, high: 1.3, jam: 1.9 },

  ALERT_TYPES: Object.freeze({
    FAN_CONFLICT: 'fan_conflict',
    EXIT_BLOCKED: 'exit_blocked',
    TRAPPED: 'trapped'
  }),

  STATUS: Object.freeze({
    CONFIG: 'config',
    RUNNING: 'running',
    PAUSED: 'paused',
    FINISHED: 'finished'
  }),

  FAN_DIRS: Object.freeze({ POS: 1, OFF: 0, NEG: -1 })
});

if (typeof module !== 'undefined' && module.exports) module.exports = CONSTANTS;
if (typeof window !== 'undefined') window.CONSTANTS = CONSTANTS;
