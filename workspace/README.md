# ❄️ 冷链仓库温控管理系统（ColdChain TMS）

冷库实时温度监控、历史曲线、自动告警与维修工单闭环的演示系统。

- **前端**：React 18 + Vite + Recharts，WebSocket 实时推送
- **后端**：Node.js（Express + ws），better-sqlite3 持久化
- **数据源**：本地模拟接口，每 5 秒采样；可注入库门开启、制冷故障、过冷、传感器离线等场景

## 快速开始

```bash
npm install          # 安装根目录及 server/client 工作区依赖
npm run dev          # 同时启动后端(3001)与前端(5173)
```

打开 http://localhost:5173 。也可以只跑后端 `npm -w server start`（已构建前端时由 3001 端口直接托管）。

生产构建：

```bash
npm run build        # 产物输出到 client/dist
npm start            # http://localhost:3001 单端口提供完整应用
```

SQLite 数据文件位于 `server/data/coldchain.db`，首次启动自动建表并回填近 24 小时模拟读数；删除该文件即可重置。

## 功能说明

### 1. 实时温度监控（首页）
- 8 个冷库（冷冻 / 冷藏 / 深冷 / 速冻 / 恒温），各自独立温区与阈值
- 卡片显示当前温度、允许区间、在线状态、上报时间与近 60 分钟迷你曲线（绿色温区带 + 上下限虚线）
- 顶部统计：在线/离线、正常/异常、活动告警（含紧急数）、进行中工单
- 卡片按告警等级描边：一般（黄）→ 重要（橙）→ 紧急（红色脉冲）

### 2. 历史曲线
点击冷库卡片打开，支持近 1 / 6 / 24 小时切换；Recharts 曲线带正常温区底色、上下限参考线、悬浮读数与时间刷选。

### 3. 心跳看门狗与离线判定（`server/src/alarms.js`）
- **判定依据是最后上报时间，而非模拟器状态**：看门狗每 5 秒扫描，某冷库超过其「离线超时阈值」仍无新读数即判离线
- 读数统一经 `ingestReading` 入口入库（**入库即心跳**）：未来接入真实网关只需把读数写到这个入口；离线期间收到第一条读数会自动上线并解除离线告警
- **抖动抑制**：短暂丢包（默认 5s 周期下连续丢失 ≤2 拍、未超过 15s 超时）不算离线，也不会重复告警；同一离线过程只生成一条告警/工单
- **温度偏高 / 偏低**：仅在真正收到新读数时判定；离线期间绝不用陈旧温度重复越限或误恢复
- **自动升级**：未受理的活动告警每 90 秒升一级（一般 → 重要 → 紧急），升级扫描每 15 秒执行；告警受理（ack）后停止升级
- 每条新告警**自动生成维修工单**，告警升级时工单优先级同步提升

### 4. 心跳参数可配置（「心跳参数」页）
- 全局默认：上报周期 5s、离线超时 15s（可用 `PUT /api/settings` 或界面修改，校验周期 1~60s、超时 5~300s、超时 ≥ 周期）
- 按冷库覆盖：`rooms.report_interval_ms / offline_timeout_ms`，留空即继承全局（`PUT /api/rooms/:id/heartbeat`）
- 冷库卡片、详情弹窗与参数页都能看到生效周期、超时阈值和最后上报时间

### 5. 维修工单闭环
`待接单 → 已接单 → 维修中 → 待恢复确认 → 已闭环`

- 接单（记录处理人）→ 开始维修 → 填报维修记录（可标记"已修复"或"待备件"）
- **恢复确认**：必须等关联告警真正恢复（温度回区 / 传感器上线）才能闭环，后端强校验
- 告警中心可对告警确认受理（停止升级）

### 6. 模拟与实时推送
- 每张冷库卡片的「模拟 ▾」菜单可注入故障/恢复
- 顶部「🎲 随机故障演练」随机挑选冷库制造故障
- 所有事件经 WebSocket 广播：新告警、升级、恢复、工单流转，右下角实时 Toast 提示，断线 3 秒自动重连

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/overview` | 冷库快照 + 近 60 分钟曲线点 |
| GET | `/api/rooms/:id/history?hours=24` | 历史读数与阈值 |
| GET | `/api/alarms?all=1` | 活动告警 / 全部告警 |
| POST | `/api/alarms/:id/ack` | 确认受理（停止升级） |
| GET | `/api/tasks` | 工单列表（可按 status 过滤） |
| POST | `/api/tasks/:id/accept` | 维修接单 |
| POST | `/api/tasks/:id/start` | 开始维修 |
| POST | `/api/tasks/:id/done` | 完成维修 `{note, restored}` |
| POST | `/api/tasks/:id/confirm` | 恢复确认（校验告警已恢复） |
| GET | `/api/heartbeat-config` | 全局 + 各冷库心跳参数（含生效值） |
| PUT | `/api/settings` | 修改全局上报周期/离线超时 |
| PUT | `/api/rooms/:id/heartbeat` | 按冷库覆盖（传 null 恢复继承全局） |
| POST | `/api/sim/rooms/:id/event` | 注入 `door_open/cooling_fault/low_temp_fault/offline/recover`（离线 = 停止发读数） |

## 目录结构

```
server/src/
  index.js      服务入口（Express + WS + 定时任务）
  db.js         SQLite 建表与查询
  seed.js       冷库档案与 24h 历史回填
  simulator.js  温度模拟（随机游走、昼夜波动、故障注入、离线抖动）
  alarms.js     阈值判定、告警创建/恢复、自动升级
  routes.js     REST API
  ws.js         WebSocket 广播总线
client/src/
  store.jsx     全局状态 + WebSocket 订阅 + 断线重连
  components/   Dashboard / RoomCard / RoomDetail / AlarmsPage / TasksPage ...
```
