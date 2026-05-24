# 同济新接口 + 湖北省妇幼接入设计

- 日期：2026-05-24
- 状态：已与用户对齐，待 writing-plans 拆步骤
- 影响范围：`server/src/server.js`、`server/.env.example`、`miniapp/pages/index/*`、`miniapp/pages/detail/*`、`miniapp/pages/settings/*`

## 1. 背景

旧的同济接口（`tjhonline.com.cn` 的 `getDoctorRegSourcesMap`，对应解析器 `tjh_reg_sources`）已失效。需要：

1. 切换到新接口 `https://tjhapp.com.cn:8013/yuyue/getdocinfoNewV2`（POST + form-urlencoded + 鉴权头）
2. 新增"湖北省妇幼保健院光谷院区超声诊断科 专家门诊"监控（按日期查询，每次 tick 14 个并行请求）
3. 首页卡片由"状态摘要"升级为"可约号源清单"
4. 监控配置从 3 个改为 3 个，但结构变化：林星光（同济光谷）/凃巍（同济光谷+汉口合并）/湖北省妇幼-光谷超声

订阅消息推送、轮询窗口（16:50-17:10 高峰 1-5s、其它 1-10 分钟）维持现有逻辑不变。

## 2. 监控配置（3 张卡片）

| Monitor ID | 医院 | 科室 | 院区过滤 | 备注 |
|---|---|---|---|---|
| `lin-xingguang` | 同济 | 产科 | 光谷院区（`hospitaldm=270018`） | 仅 `deptCode=020302`，状态=`可约` |
| `tu-wei` | 同济 | 风湿免疫内科 | 光谷+汉口（`hospitaldm∈{270017,270018}`） | 仅 `deptCode=010108`，状态=`可约`。合并旧的 `tu-wei-hankou` + `tu-wei-guanggu` |
| `hbfy-guanggu-chaosheng` | 湖北省妇幼 | 超声诊断科 专家门诊 | 光谷院区（`deptCode=633`） | 不限定医生；状态≠`2` 即视为可约 |

## 3. 同济适配层（解析器 `tjhapp_v2`）

### 3.1 请求

```
POST https://tjhapp.com.cn:8013/yuyue/getdocinfoNewV2
Content-Type: application/x-www-form-urlencoded

Headers:
  plan: wxapp
  uname: {{HOSPITAL_TJH_UNAME}}
  uuid: {{HOSPITAL_TJH_UUID}}
  ukey: {{HOSPITAL_TJH_UKEY}}
  token: {{HOSPITAL_TJH_TOKEN}}
  X-Requested-With: XMLHttpRequest
  Origin: https://tjhapp.com.cn
  Referer: https://tjhapp.com.cn/
  User-Agent: <复用现有默认 UA>

Body:
  yqcode1={{yqcode1}}
  kscode1={{kscode1}}
  doctorCode={{doctorCode}}
  scheduleType=
  laterThan17=true
```

### 3.2 同济 monitor 请求/过滤配置

```json
{
  "lin-xingguang": {
    "parser": "tjhapp_v2",
    "doctorName": "林星光",
    "hospitalName": "同济光谷院区",
    "departmentName": "产科",
    "request": { "yqcode1": "270018", "kscode1": "02030201", "doctorCode": "101573" },
    "filter": {
      "hospitaldm": ["270018"],
      "deptCode": ["020302"],
      "yystatus": ["可约"]
    }
  },
  "tu-wei": {
    "parser": "tjhapp_v2",
    "doctorName": "凃巍",
    "hospitalName": "同济光谷+汉口",
    "departmentName": "风湿免疫内科",
    "request": { "yqcode1": "270018", "kscode1": "02010801", "doctorCode": "101110" },
    "filter": {
      "hospitaldm": ["270017", "270018"],
      "deptCode": ["010108"],
      "yystatus": ["可约"]
    }
  }
}
```

### 3.3 响应解析（以 `datalistbyyq[]` 为主）

逐条遍历 `response.datalistbyyq[*].schedule[*]`，对每条 schedule：
1. 取出所属 `hospitaldm`（来自外层 `datalistbyyq[*].hospitaldm`）
2. 应用 monitor 的 `filter`：
   - `hospitaldm` 必须在白名单内
   - `deptCode` 必须在白名单内
   - `yystatus` 必须在白名单内（默认 `["可约"]`）
3. 通过 filter 的 schedule → 转成内部 slot

天然结果：本身 deptCode 过滤就排除了 023316/023307 这些 601.5 元的国际号。

### 3.4 字段映射

| 内部统一字段 | 同济新接口 |
|---|---|
| `visitDate` | `clinicDate` |
| `weekday` | 从 `clinicDate` 计算 |
| `durationName` | `clinicDuration`（"上午"/"下午"） |
| `regPrice` | `sumFee` |
| `availableStatusName` | `yystatus` |
| `hasAvailability` | `yystatus === "可约"` |
| `hospitalName` | 来自 `datalistbyyq[*].hospitalmc`（光谷院区 / 汉口院区） |
| `hospitalId` | `hospitaldm` |
| `departmentName` | `deptName`（"产科" / "风湿免疫内科"） |
| `departmentCode` | `deptCode` |
| `scheduleId` | `schedulecode` |
| `notificationKey` | `${monitorId}:${hospitaldm}:${clinicDate}:${clinicDuration}:${deptCode}:${schedulecode}` |

## 4. 湖北省妇幼适配层（解析器 `hbfy_dept_date`）

### 4.1 请求（每次 tick 并行 14 个）

```
GET https://hbfy3.hbfy.com/Micro04/reservegh
  ?cls=yygh
  &m=geteffdoctorlistext
  &choiceType=1
  &deptCode=633
  &deptLevel=2
  &doctType=2
  &funcId=function03
  &parentId=633
  &outpDate={{YYYY-MM-DD}}
```

- `outpDate` 从今天起 14 天，使用 `Asia/Shanghai` 时区
- 14 个请求用 `Promise.all` 并行
- 暂无鉴权 header；预留 `.env` 注入扩展能力，将来如需可配置

### 4.2 湖北省妇幼 monitor 配置

```json
{
  "hbfy-guanggu-chaosheng": {
    "parser": "hbfy_dept_date",
    "doctorName": null,
    "hospitalName": "湖北省妇幼-光谷",
    "departmentName": "超声诊断科 专家门诊",
    "request": {
      "deptCode": "633",
      "deptLevel": "2",
      "doctType": "2",
      "funcId": "function03",
      "parentId": "633",
      "choiceType": "1"
    },
    "windowDays": 14,
    "filter": {
      "excludeStatuses": ["2"]
    }
  }
}
```

### 4.3 响应解析

对每个日期的响应：
```
response.doclist[*]
  ├─ scheduleExtInfo.morning  → 若非 null 且 status ∉ excludeStatuses → 一条上午 slot
  └─ scheduleExtInfo.afternoon → 若非 null 且 status ∉ excludeStatuses → 一条下午 slot
```

**状态规则**（用户确认）：
- `status === "2"` → 约满（过滤）
- `status === "1"` → 可约（命中）
- 其它值（如 `"0"`、`"3"`）→ 默认按"可约"处理，并在 server 日志写一条 `warn`：`unexpected hbfy status: <value>`（便于后续观察是否需要调整规则）

### 4.4 字段映射

| 内部统一字段 | 湖北省妇幼 |
|---|---|
| `visitDate` | `scheduleExtInfo.outpDate` |
| `weekday` | 从 `outpDate` 计算 |
| `durationName` | 上午 / 下午（根据 morning/afternoon 字段判断） |
| `regPrice` | `morning.fee` / `afternoon.fee` |
| `availableStatusName` | 由 `status` 推断（`1→"可约"`，其它→`status` 原值字符串） |
| `hasAvailability` | `status !== "2"` |
| `hospitalName` | "湖北省妇幼-光谷"（来自 monitor 配置） |
| `hospitalId` | `hospital_id`（GUID） |
| `departmentName` | "超声诊断科" |
| `departmentCode` | `dept_code` |
| `doctorName` | `doctor_name` |
| `doctorCode` | `doctor_no` |
| `scheduleId` | `scheduleInfo.scheduleId` |
| `notificationKey` | `hbfy-guanggu-chaosheng:${doctor_no}:${outpDate}:${timeInterval}` |

## 5. 后端结构调整

- `server/src/server.js`：
  - 抽出 `parseTjhappV2(response, filter)`，与旧 `parseTjhRegSources` 并列（旧函数保留但不再被调用，目的：方便回滚 / 参考）
  - 新增 `parseHbfyDeptDate(response, filter, dateContext)`
  - 新增 `fetchHbfyForRange(monitor, days)`：并行 14 个 GET，合并 slots
  - 调度器（轮询/高峰窗口）逻辑不动，仅改"每个 monitor 怎么取数据"
- 鉴权头组装：把同济相关的 4 个 header（uname/uuid/ukey/token）从 `.env` 注入，复用现有的 `{{placeholder}}` 模板机制

## 6. 前端 UI

### 6.1 首页卡片

- 数据形态：每张卡片 `slots[]` 字段，元素结构（来自后端 `/api/monitors`）：
  ```
  { visitDate, durationName, regPrice, doctorName?, hospitalName?, available }
  ```
- 显示规则：
  - 卡片标题：`{doctorName 或 monitor.doctorName 占位} ｜ {monitor.hospitalName}`
  - 状态行：✅有号 / ⚪暂无可约 / ⏸已暂停
  - 有号时列出全部"可约"号源，**不截断**（号源数量本身不会很多）
  - 凃巍卡片每行带院区前缀（光谷 / 汉口）
  - 妇幼卡片每行带医生名

### 6.2 详情页

- 复用现有 slot 列表渲染。统一字段（`visitDate`/`durationName` 等）由后端返回
- 不再做"专家门诊/普通门诊"切换（之前 PRD 中的 `ghlx` 过滤）；新需求只关心"可约"

### 6.3 设置页

- 监控列表改为 3 项（林星光、凃巍、妇幼光谷超声）
- 仍为只读，不引入用户配置

## 7. `.env` 变更（增量）

```bash
# 同济新接口
HOSPITAL_TJH_API_ENABLED=true
HOSPITAL_TJH_UNAME=
HOSPITAL_TJH_UUID=
HOSPITAL_TJH_UKEY=
HOSPITAL_TJH_TOKEN=

# 湖北省妇幼
HOSPITAL_HBFY_API_ENABLED=true
HOSPITAL_HBFY_WINDOW_DAYS=14

# Monitor 配置（覆盖旧的 HOSPITAL_DOCTOR_SOURCE_CONFIG_JSON）
# 完整 JSON 见 §3.2（lin-xingguang、tu-wei）+ §4.2（hbfy-guanggu-chaosheng）
# 部署时三者拼到同一个对象里，单行 JSON 写入 .env
HOSPITAL_DOCTOR_SOURCE_CONFIG_JSON=<see §3.2 + §4.2>
```

旧 vars 处理：
- `HOSPITAL_AVAILABILITY_URL`、`HOSPITAL_AVAILABILITY_METHOD`、`HOSPITAL_RESPONSE_FORMAT`、`HOSPITAL_ACCESS_TOKEN*`、`HOSPITAL_AVAILABLE_KEYWORDS`、`HOSPITAL_UNAVAILABLE_KEYWORDS`：从 `.env.example` 中移除（解析器从 monitor 配置的 `parser` 字段决定，不再走全局变量）

## 8. 推送

- 模板字段保持现有 3 字段（`time1`、`short_thing2`、`thing3`）
- 文案模板调整：
  - 同济：`{doctorName} {visitDate} {weekday} {durationName} {hospitalName} 有号，挂号费 {regPrice} 元`
  - 妇幼：`妇幼光谷超声 {visitDate} {weekday} {durationName} {doctorName} 有号，挂号费 {regPrice} 元`
- `short_thing2`：同济为医生名（如"林星光"），妇幼为科室简称（如"妇幼超声"，因为没有固定医生）
- 通知去重：沿用 `notified-slots.json`，key 见 §3.4 / §4.4 的 `notificationKey`

## 9. 轮询

- 维持现有 `16:50-17:10` 高峰窗口（1-5s）和平时（1-10min）
- 同济 2 个 monitor + 妇幼 1 个 monitor = 每 tick 16 个 HTTP 请求（2 同济 + 14 妇幼）
- 妇幼 14 请求用 `Promise.all` 并行，避免串行延迟

## 10. 验证 / 测试

- 后端：
  - `/api/monitor/tick` 强制跑一次，检查 3 个 monitor 的 slots 输出
  - `/api/hospital/debug-availability?id=lin-xingguang` 等 3 个 id 应都能返回有效数据
  - 模拟"可约"状态变化（手动改 `notified-slots.json`），看是否触发推送
- 小程序：
  - 真机预览首页 3 张卡片，确认"可约清单"渲染正确
  - 详情页 slot 列表显示正常
  - 妇幼卡片显示医生名

## 11. 已知风险

1. **同济鉴权过期**：`token`/`ukey` 失效后所有同济请求会失败。处理：日志 `error`，monitor `lastResultSummary` 显示"鉴权失败，请更新 .env"。**手动更新**，不做自动刷新
2. **湖北省妇幼状态码 1 含义未确认**：日志会 warn 出非 1/2 的所有 status 值，便于后续调整规则
3. **峰值期 16:50-17:10 触发 16 请求/秒**：可能被任一家医院限流；如出现 4xx/5xx 增多，再调整为同济保持 1-5s、妇幼降级到 5-10s
4. **妇幼接口未来加鉴权**：留 `.env` 注入扩展点，但当前不实现
