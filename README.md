# 城市隧道通风与火灾疏散推演系统

零依赖的隧道火灾推演与处置方案对比平台：24 区段隧道（2.4km）的烟雾/温度/能见度实时演化、人员疏散仿真、射流风机联动、多方案同步回放与中断恢复。

## 启动

```bash
node server.js          # 需要 Node.js >= 18
# 打开 http://localhost:3000
npm test                # 运行引擎测试（11 项）
```

## 功能

**1. 隧道运行场景**
- 24 个区段连续展示车辆分布（🚗n）、烟雾浓度（灰度）、温度（热力着色）、能见度、风速风向、风机（🌀）与疏散通道（🚪）状态
- 起火点🚒、危险区段（红色虚线）、被困区段（橙色脉冲）实时标记
- 点击任一区段查看该区段烟雾/温度/能见度/风速/人员/车辆实时值与近 2 分钟趋势图

**2. 推演控制**
- 场景设置：起火位置（滑杆选段）、火势 Ⅰ/Ⅱ/Ⅲ 级、交通密度 0–100%
- 启动 / 暂停 / 单步（2 秒现实时间/帧，0.5 秒推进一帧）
- 推演中可随时调整任意风机方向（东/西/停）、批量同向、启闭疏散通道、模拟灭火
- 每次决策锚定在当前时间轴 tick，系统按操作即时重算后续烟雾扩散与疏散时间
- 时间轴标记起火、决策、被困、伤亡、完成事件；可「回到该节点」截断重推，或「从此节点分叉」派生新方案

**3. 方案对比**
- 保存任意多个处置方案（时间轴分叉自动保留原方案），右上角「方案对比」
- 多方案同步播放/逐帧拖动，迷你隧道条并排展示烟雾/高温/被困区
- 指标表对比已撤离、被困/滞留、受危及人数、剩余人数、实际完成时刻（完成后按综合评分🏆标最优）
- 风机对吹冲突（气流停滞区间）、出口封闭、人员被困均按回放帧动态高亮原因与影响区段

**4. 中断恢复**
- 所有方案以「初始设定 + 决策序列」为事件源，加上紧凑帧快照原子落盘到 `data/sessions/*.json`（临时文件 + rename）
- 页面刷新：SSE 重连后自动用服务端帧序列校准；服务重启：启动时事件重放恢复全部未完成推演（以暂停态），顶部绿色横幅提示断点，可直接继续
- 非法/失败操作在服务端整体回滚（状态 + 时间轴），前端提示「已回滚到最近有效状态」

## 物理与疏散模型（lib/engine.js）

- 烟雾/热量：上风半拉格朗日平流 + 紊流逆扩散 + 烟雾沉降/环境散热；产烟产热随火势等级
- 气流：6 台射流风机（2/6/10/14/18/22 段），单台 1.2 m/s、影响前后 4 段叠加自然活塞风
- 能见度：由烟雾浓度换算（浓烟低能见度）
- 疏散：开放出口反向 BFS 求各区段最近出口；高温(≥60℃)/浓烟/能见度<8m 阻断路径；步行速度随能见度与高温衰减；出口按通行能力通过；阻断致困、高温减员
- 冲突检测：相距 ≤8 段的东、西向对吹风机，标出停滞影响区间

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/config` | 隧道/风机/出口配置 |
| POST | `/api/sessions` | 新建方案 `{name, setup:{fireSegment,fireLevel,trafficDensity}}` |
| GET | `/api/sessions` | 方案列表 |
| GET | `/api/sessions/:id` | 当前快照（含决策、告警） |
| DELETE | `/api/sessions/:id` | 删除方案 |
| GET | `/api/sessions/:id/stream` | SSE 实时事件（snapshot/tick/decision/status/seek/error） |
| POST | `/api/sessions/:id/control` | `{action: start|pause|step}` |
| POST | `/api/sessions/:id/decision` | `setFan` / `allFans` / `toggleExit` / `extinguish` |
| GET | `/api/sessions/:id/frames` | 完整紧凑帧序列 |
| POST | `/api/sessions/:id/branch` | 从 tick 分叉新方案 |
| POST | `/api/sessions/:id/seek` | 截断并回到 tick |
| GET | `/api/compare?ids=a,b` | 多方案完整数据（同步回放） |

## 目录结构

```
server.js           HTTP 服务（REST + SSE，零依赖）
lib/engine.js       物理/疏散推演引擎（纯函数 tick）
lib/decisions.js    决策校验、风机冲突检测、事件重放
lib/store.js        会话内存态、定时器、JSON 原子持久化
public/             原生前端（index.html / app.js / view.js / timeline.js / compare.js）
tests/engine.test.js 引擎回归测试
data/sessions/      方案持久化（自动生成）
```
