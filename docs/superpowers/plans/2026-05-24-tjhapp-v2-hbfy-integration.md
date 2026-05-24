# 同济新接口 + 湖北省妇幼接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把后端医院适配层从失效的旧同济接口切换到新的 `tjhapp.com.cn:8013` v2 接口，并新增"湖北省妇幼保健院光谷超声"按日期监控（14 天滚动并行查询）；首页卡片改为列出可约号源清单。

**Architecture:** 在 `server/src/parsers/` 下新增两个纯函数解析器（`tjhapp-v2.js`、`hbfy-dept-date.js`），由 `server.js` 中的 `queryHospitalAvailability` 按 monitor 配置里的 `parser` 字段分发。旧解析器 `parseTjhRegSources` 保留作为回滚参考，但所有 monitor 都迁移到新解析器。小程序首页/详情/设置页适配新的 monitor 列表（3 张卡片：林星光、凃巍合并、妇幼光谷超声）和"可约清单"展示。

**Tech Stack:** Node.js 20+ 原生模块（`node:http`、`node:test`、`fetch`）、ES Modules（package.json `"type": "module"`）、原生微信小程序（WXML/WXSS/JS）。无 npm 依赖。

参考 spec：`docs/superpowers/specs/2026-05-24-tjhapp-v2-hbfy-integration-design.md`

---

## File Structure

### 新建文件
| 路径 | 职责 |
|---|---|
| `server/src/parsers/tjhapp-v2.js` | 解析 `tjhapp.com.cn:8013/yuyue/getdocinfoNewV2` 响应，按 `hospitaldm` / `deptCode` / `yystatus` 过滤，返回统一 slot 数组 |
| `server/src/parsers/hbfy-dept-date.js` | 解析 `hbfy3.hbfy.com/Micro04/reservegh` 响应（单日），按 `morning.status` / `afternoon.status` 判断可约，返回统一 slot 数组 |
| `server/test/tjhapp-v2.test.js` | `parseTjhappV2` 的 `node:test` 单元测试 |
| `server/test/hbfy-dept-date.test.js` | `parseHbfyDeptDate` 的 `node:test` 单元测试 |
| `server/test/fixtures/tjhapp-v2-lin-xingguang.json` | 林星光真实响应样本（来自 spec 调研） |
| `server/test/fixtures/tjhapp-v2-tu-wei.json` | 凃巍真实响应样本 |
| `server/test/fixtures/hbfy-dept-date.json` | 妇幼真实响应样本 |

### 修改文件
| 路径 | 修改点 |
|---|---|
| `server/package.json` | 增加 `"test": "node --test test/"` |
| `server/src/server.js` | 接入新解析器；改写 `monitors`、`legacyDoctorSourceConfigAliases`、`queryHospitalAvailability`、`buildSubscribeAlertTip`、`getSlotNotificationKey`；新增 `queryTjhappV2(monitor)`、`queryHbfyDeptDate(monitor)` |
| `server/.env.example` | 增加 `HOSPITAL_TJH_*`、`HOSPITAL_HBFY_*`；更新 `HOSPITAL_DOCTOR_SOURCE_CONFIG_JSON` |
| `miniapp/pages/index/index.js` | `loadMonitors` 内对 `monitor.availableSlots` 二次格式化（出医生名/院区前缀） |
| `miniapp/pages/index/index.wxml` | 卡片内新增 `availableSlots` 循环渲染 |
| `miniapp/pages/index/index.wxss` | 新增可约号源条目样式 |
| `miniapp/pages/detail/detail.js` | `loadMonitor` 的 slot 状态类名映射兼容 `yystatus`/HBFY status |
| `miniapp/pages/detail/detail.wxml` | slot 行展示 `doctorName`（妇幼）和 `hospitalName`（凃巍） |
| `miniapp/pages/settings/settings.wxml` | 更新 3 个 monitor 文案 |

### 文件大小
`server/src/server.js` 当前 ~1625 行，本次新增大约 +120 行（净增；旧路径保留），仍在可管理范围。

---

## Pre-flight：测试数据准备

在写代码之前先把真实响应样本固化为 fixture 文件。这些样本来自 spec 第 1 节的对话调研。

- [ ] **Step 1: 创建 fixture 目录**

Run: `New-Item -ItemType Directory -Path "server/test/fixtures" -Force`

- [ ] **Step 2: 写林星光响应 fixture**

Create `server/test/fixtures/tjhapp-v2-lin-xingguang.json` with the full JSON from spec §1 (the response body the user posted for 林星光). It must contain `datalistbyyq[]` for 光谷院区 / 汉口院区 / 中法院区 / 军山院区, with mixed `deptCode` values including `020302`、`0203010303`、`023316`、`010302`，and mixed `yystatus` values including `可约`、`候补`、`候满`、`截止`.

The complete JSON is in the user's earlier message in the design conversation; copy verbatim.

- [ ] **Step 3: 写凃巍响应 fixture**

Create `server/test/fixtures/tjhapp-v2-tu-wei.json` with the 凃巍 response from spec §1. Must include `datalistbyyq[]` for 光谷院区 (with `deptCode=023307` `yystatus=可约`) and 汉口院区 (with `deptCode=010108` `yystatus=候满`).

- [ ] **Step 4: 写妇幼响应 fixture**

Create `server/test/fixtures/hbfy-dept-date.json` with the response from the user's hbfy curl. Must include the `doclist[]` with 14 doctors, where:
- Some have `scheduleExtInfo.morning=null, afternoon=null` (no schedule)
- Some have `morning.status="2", afternoon.status="2"` (full)
- (For testing status="1", we'll synthesize an extra entry inline in the test file — see Task 4)

- [ ] **Step 5: Commit fixtures**

```powershell
git add server/test/fixtures/
git commit -m "test(server): add hospital API response fixtures"
```

---

## Task 1: tjhapp_v2 parser（基础解析 + 林星光过滤）

**Files:**
- Create: `server/src/parsers/tjhapp-v2.js`
- Create: `server/test/tjhapp-v2.test.js`
- Modify: `server/package.json`

- [ ] **Step 1: 加 npm test 脚本**

Edit `server/package.json` to add `test` script:

```json
{
  "name": "haolaile-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node src/server.js",
    "start": "node src/server.js",
    "test": "node --test test/"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: 写失败测试 — 林星光只匹配光谷+020302+可约**

Create `server/test/tjhapp-v2.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseTjhappV2 } from "../src/parsers/tjhapp-v2.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const linXingguangFixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/tjhapp-v2-lin-xingguang.json"), "utf8")
);

test("parseTjhappV2: 林星光仅返回光谷+020302+可约的 slot", () => {
  const result = parseTjhappV2(linXingguangFixture, {
    monitorId: "lin-xingguang",
    doctorName: "林星光",
    departmentName: "产科",
    filter: {
      hospitaldm: ["270018"],
      deptCode: ["020302"],
      yystatus: ["可约"]
    }
  });

  assert.equal(result.hasAvailability, false, "样本中 deptCode=020302 均为候补/候满，无可约");
  assert.equal(result.availableSlots.length, 0);
  assert.equal(
    result.slots.every((slot) => slot.hospitalId === "270018"),
    true,
    "所有 slot 必须是光谷院区"
  );
  assert.equal(
    result.slots.every((slot) => slot.deptCode === "020302"),
    true,
    "所有 slot 必须是 020302 产科"
  );
});
```

- [ ] **Step 3: 跑测试看它失败**

Run: `cd server; npm test`

Expected: 因为 `parseTjhappV2` 还不存在，import 报错 `Cannot find module './parsers/tjhapp-v2.js'`。

- [ ] **Step 4: 写最小实现让测试通过**

Create `server/src/parsers/tjhapp-v2.js`:

```js
export function parseTjhappV2(payload, options) {
  const { monitorId, filter = {} } = options;
  const allowedHospitals = new Set((filter.hospitaldm || []).map(String));
  const allowedDepts = new Set((filter.deptCode || []).map(String));
  const allowedStatuses = new Set((filter.yystatus || ["可约"]).map(String));

  const slots = [];
  const groups = Array.isArray(payload?.datalistbyyq) ? payload.datalistbyyq : [];

  for (const group of groups) {
    const hospitaldm = String(group.hospitaldm || "");
    if (allowedHospitals.size > 0 && !allowedHospitals.has(hospitaldm)) {
      continue;
    }
    const schedules = Array.isArray(group.schedule) ? group.schedule : [];
    for (const schedule of schedules) {
      const deptCode = String(schedule.deptCode || "");
      if (allowedDepts.size > 0 && !allowedDepts.has(deptCode)) {
        continue;
      }
      const yystatus = String(schedule.yystatus || "");
      const isAvailable = allowedStatuses.has(yystatus);
      const slot = toTjhappSlot(schedule, group, isAvailable, monitorId);
      slots.push(slot);
    }
  }

  const availableSlots = slots.filter((slot) => slot.available);
  return {
    hasAvailability: availableSlots.length > 0,
    slots,
    availableSlots
  };
}

function toTjhappSlot(schedule, group, isAvailable, monitorId) {
  const visitDate = String(schedule.clinicDate || "");
  const durationName = String(schedule.clinicDuration || "");
  const deptCode = String(schedule.deptCode || "");
  const schedulecode = String(schedule.schedulecode || "");
  const hospitaldm = String(group.hospitaldm || "");

  return {
    available: isAvailable,
    availableStatus: String(schedule.yystatus || ""),
    availableStatusName: String(schedule.yystatus || ""),
    scheduleId: schedulecode,
    doctorCode: String(schedule.doctorCode || ""),
    doctorName: "",
    hospitalId: hospitaldm,
    hospitalName: String(group.hospitalmc || ""),
    deptCode,
    deptName: String(schedule.deptName || ""),
    departmentName: String(schedule.deptName || ""),
    visitDate,
    weekday: weekdayFromIsoDate(visitDate),
    durationCode: durationName === "上午" ? "AM" : durationName === "下午" ? "PM" : "",
    durationName,
    regTypeCode: String(schedule.scheduleType || ""),
    regTypeName: String(schedule.ghlx || ""),
    regPrice: schedule.sumFee !== undefined ? String(schedule.sumFee) : "",
    specCode: deptCode,
    specName: String(schedule.deptName || ""),
    notificationKey: `${monitorId}:${hospitaldm}:${visitDate}:${durationName}:${deptCode}:${schedulecode}`
  };
}

function weekdayFromIsoDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  if (!match) return "";
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(date);
}
```

- [ ] **Step 5: 跑测试看它通过**

Run: `cd server; npm test`

Expected: 1/1 test passes.

- [ ] **Step 6: Commit**

```powershell
git add server/package.json server/src/parsers/tjhapp-v2.js server/test/tjhapp-v2.test.js
git commit -m "feat(server): add tjhapp_v2 parser with lin-xingguang test"
```

---

## Task 2: tjhapp_v2 parser（凃巍多院区 + 可约命中场景）

**Files:**
- Modify: `server/test/tjhapp-v2.test.js`
- Modify: `server/src/parsers/tjhapp-v2.js`（如有必要）

- [ ] **Step 1: 加凃巍跨院区测试**

Append to `server/test/tjhapp-v2.test.js`:

```js
const tuWeiFixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/tjhapp-v2-tu-wei.json"), "utf8")
);

test("parseTjhappV2: 凃巍接受光谷+汉口，仅 010108 + 可约", () => {
  const result = parseTjhappV2(tuWeiFixture, {
    monitorId: "tu-wei",
    doctorName: "凃巍",
    departmentName: "风湿免疫内科",
    filter: {
      hospitaldm: ["270017", "270018"],
      deptCode: ["010108"],
      yystatus: ["可约"]
    }
  });

  assert.equal(result.hasAvailability, false, "样本中 010108 全为候满/候补，无可约");
  assert.ok(result.slots.length >= 6, `应包含汉口 010108 的全部排班（6 条）`);
  assert.equal(
    result.slots.every((slot) => slot.deptCode === "010108"),
    true,
    "deptCode 必须是 010108（023307 国际号必须被过滤掉）"
  );
});

test("parseTjhappV2: 命中可约场景", () => {
  const fakePayload = {
    datalistbyyq: [
      {
        hospitalmc: "汉口院区",
        hospitaldm: "270017",
        schedule: [
          {
            deptName: "风湿免疫内科",
            schedulecode: "FAKE001",
            scheduleType: "3",
            clinicDate: "2026-05-30",
            doctorCode: "101110",
            sumFee: 18.5,
            yystatus: "可约",
            ghlx: "专家门诊",
            clinicDuration: "上午",
            deptCode: "010108"
          }
        ]
      }
    ]
  };

  const result = parseTjhappV2(fakePayload, {
    monitorId: "tu-wei",
    doctorName: "凃巍",
    filter: {
      hospitaldm: ["270017", "270018"],
      deptCode: ["010108"],
      yystatus: ["可约"]
    }
  });

  assert.equal(result.hasAvailability, true);
  assert.equal(result.availableSlots.length, 1);
  const slot = result.availableSlots[0];
  assert.equal(slot.available, true);
  assert.equal(slot.hospitalName, "汉口院区");
  assert.equal(slot.regPrice, "18.5");
  assert.equal(slot.notificationKey, "tu-wei:270017:2026-05-30:上午:010108:FAKE001");
});
```

- [ ] **Step 2: 跑测试**

Run: `cd server; npm test`

Expected: 3/3 tests pass（如果实现正确，无需修改解析器）。如有失败，按错误信息修正。

- [ ] **Step 3: 加空响应 / 异常输入测试**

Append:

```js
test("parseTjhappV2: 空/异常输入安全降级", () => {
  assert.deepEqual(parseTjhappV2(null, { monitorId: "x" }), {
    hasAvailability: false,
    slots: [],
    availableSlots: []
  });
  assert.deepEqual(parseTjhappV2({}, { monitorId: "x" }), {
    hasAvailability: false,
    slots: [],
    availableSlots: []
  });
  assert.deepEqual(parseTjhappV2({ datalistbyyq: "bad" }, { monitorId: "x" }), {
    hasAvailability: false,
    slots: [],
    availableSlots: []
  });
});
```

- [ ] **Step 4: 跑测试**

Run: `cd server; npm test`

Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```powershell
git add server/test/tjhapp-v2.test.js
git commit -m "test(server): cover tjhapp_v2 multi-campus and edge cases"
```

---

## Task 3: hbfy_dept_date parser（单日响应解析）

**Files:**
- Create: `server/src/parsers/hbfy-dept-date.js`
- Create: `server/test/hbfy-dept-date.test.js`

- [ ] **Step 1: 写第一个测试 — status=2 全约满 → 无可约**

Create `server/test/hbfy-dept-date.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHbfyDeptDate } from "../src/parsers/hbfy-dept-date.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/hbfy-dept-date.json"), "utf8")
);

test("parseHbfyDeptDate: 全 status=2 样本无可约", () => {
  const result = parseHbfyDeptDate(fixture, {
    monitorId: "hbfy-guanggu-chaosheng",
    outpDate: "2026-05-25",
    filter: { excludeStatuses: ["2"] }
  });

  assert.equal(result.hasAvailability, false);
  assert.equal(result.availableSlots.length, 0);
  assert.ok(result.slots.length >= 6, `应至少包含 morning/afternoon 非 null 的 6 条排班（鲁力 AM+PM、路小军 AM+PM、杨小红 AM+PM）`);
  assert.equal(
    result.slots.every((slot) => slot.available === false),
    true
  );
});
```

- [ ] **Step 2: 跑测试看它失败**

Run: `cd server; npm test`

Expected: import 报错 `Cannot find module './parsers/hbfy-dept-date.js'`。

- [ ] **Step 3: 写最小实现**

Create `server/src/parsers/hbfy-dept-date.js`:

```js
export function parseHbfyDeptDate(payload, options) {
  const { monitorId, outpDate, filter = {}, onUnknownStatus } = options;
  const excludeStatuses = new Set((filter.excludeStatuses || ["2"]).map(String));

  const slots = [];
  const doctors = Array.isArray(payload?.doclist) ? payload.doclist : [];

  for (const doctor of doctors) {
    const ext = doctor.scheduleExtInfo || {};
    const dateValue = String(ext.outpDate || outpDate || "");

    if (ext.morning && typeof ext.morning === "object") {
      slots.push(toHbfySlot(doctor, ext.morning, "上午", "AM", dateValue, excludeStatuses, monitorId, onUnknownStatus));
    }
    if (ext.afternoon && typeof ext.afternoon === "object") {
      slots.push(toHbfySlot(doctor, ext.afternoon, "下午", "PM", dateValue, excludeStatuses, monitorId, onUnknownStatus));
    }
  }

  const availableSlots = slots.filter((slot) => slot.available);
  return {
    hasAvailability: availableSlots.length > 0,
    slots,
    availableSlots
  };
}

function toHbfySlot(doctor, period, durationName, durationCode, visitDate, excludeStatuses, monitorId, onUnknownStatus) {
  const status = String(period.status || "");
  const isAvailable = !excludeStatuses.has(status);
  let availableStatusName = "未知";
  if (status === "1") availableStatusName = "可约";
  else if (status === "2") availableStatusName = "约满";
  else {
    availableStatusName = `status=${status}`;
    if (typeof onUnknownStatus === "function") {
      onUnknownStatus(status, doctor, period);
    }
  }

  const scheduleId = String(period.scheduleInfo?.scheduleId || "");
  const doctorNo = String(doctor.doctor_no || "");

  return {
    available: isAvailable,
    availableStatus: status,
    availableStatusName,
    scheduleId,
    doctorCode: doctorNo,
    doctorName: String(doctor.doctor_name || ""),
    hospitalId: String(doctor.hospital_id || ""),
    hospitalName: String(doctor.hospital_name || ""),
    deptCode: String(doctor.dept_code || ""),
    deptName: String(doctor.dept_name || ""),
    departmentName: String(doctor.dept_name || ""),
    visitDate,
    weekday: weekdayFromIsoDate(visitDate),
    durationCode,
    durationName,
    regTypeCode: "",
    regTypeName: String(period.value || ""),
    regPrice: period.fee !== undefined ? String(period.fee) : "",
    specCode: String(doctor.dept_code || ""),
    specName: String(doctor.dept_name || ""),
    notificationKey: `${monitorId}:${doctorNo}:${visitDate}:${durationCode}`
  };
}

function weekdayFromIsoDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  if (!match) return "";
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(date);
}
```

- [ ] **Step 4: 跑测试看它通过**

Run: `cd server; npm test`

Expected: 5/5 pass (4 from Task 2 + 1 new).

- [ ] **Step 5: Commit**

```powershell
git add server/src/parsers/hbfy-dept-date.js server/test/hbfy-dept-date.test.js
git commit -m "feat(server): add hbfy_dept_date parser with full-booked fixture test"
```

---

## Task 4: hbfy_dept_date parser（status=1 可约 + 未知 status 警告）

**Files:**
- Modify: `server/test/hbfy-dept-date.test.js`

- [ ] **Step 1: 加 status=1 命中可约测试**

Append to `server/test/hbfy-dept-date.test.js`:

```js
test("parseHbfyDeptDate: status=1 视为可约", () => {
  const payload = {
    doclist: [
      {
        doctor_no: "1803611219823",
        doctor_name: "鲁力",
        hospital_id: "guid-x",
        hospital_name: "光谷院区",
        dept_code: "633",
        dept_name: "专家门诊",
        scheduleExtInfo: {
          outpDate: "2026-05-30",
          morning: {
            status: "1",
            value: "专家号",
            fee: "14.5",
            scheduleInfo: { scheduleId: "SCHED-AM" }
          },
          afternoon: {
            status: "2",
            value: "专家号",
            fee: "14.5",
            scheduleInfo: { scheduleId: "SCHED-PM" }
          }
        }
      }
    ]
  };

  const result = parseHbfyDeptDate(payload, {
    monitorId: "hbfy-guanggu-chaosheng",
    outpDate: "2026-05-30",
    filter: { excludeStatuses: ["2"] }
  });

  assert.equal(result.hasAvailability, true);
  assert.equal(result.availableSlots.length, 1);
  const slot = result.availableSlots[0];
  assert.equal(slot.doctorName, "鲁力");
  assert.equal(slot.durationName, "上午");
  assert.equal(slot.availableStatusName, "可约");
  assert.equal(slot.regPrice, "14.5");
  assert.equal(slot.notificationKey, "hbfy-guanggu-chaosheng:1803611219823:2026-05-30:AM");
});

test("parseHbfyDeptDate: 未知 status 触发回调并默认可约", () => {
  const payload = {
    doclist: [
      {
        doctor_no: "DOC1",
        doctor_name: "测试医生",
        scheduleExtInfo: {
          outpDate: "2026-05-30",
          morning: {
            status: "0",
            value: "专家号",
            fee: "20",
            scheduleInfo: { scheduleId: "S1" }
          },
          afternoon: null
        }
      }
    ]
  };

  let captured = null;
  const result = parseHbfyDeptDate(payload, {
    monitorId: "hbfy-guanggu-chaosheng",
    outpDate: "2026-05-30",
    filter: { excludeStatuses: ["2"] },
    onUnknownStatus: (status) => {
      captured = status;
    }
  });

  assert.equal(captured, "0", "应触发 onUnknownStatus 回调");
  assert.equal(result.hasAvailability, true, "未知 status 默认按可约");
  assert.equal(result.availableSlots[0].availableStatusName, "status=0");
});

test("parseHbfyDeptDate: morning/afternoon 全 null → 无 slot", () => {
  const payload = {
    doclist: [
      {
        doctor_no: "DOC2",
        doctor_name: "甲",
        scheduleExtInfo: { outpDate: "2026-05-30", morning: null, afternoon: null }
      }
    ]
  };

  const result = parseHbfyDeptDate(payload, {
    monitorId: "hbfy-guanggu-chaosheng",
    outpDate: "2026-05-30",
    filter: { excludeStatuses: ["2"] }
  });

  assert.equal(result.slots.length, 0);
  assert.equal(result.hasAvailability, false);
});

test("parseHbfyDeptDate: 空 doclist 安全降级", () => {
  assert.deepEqual(
    parseHbfyDeptDate({ doclist: [] }, { monitorId: "x", outpDate: "2026-05-30" }),
    { hasAvailability: false, slots: [], availableSlots: [] }
  );
  assert.deepEqual(
    parseHbfyDeptDate(null, { monitorId: "x", outpDate: "2026-05-30" }),
    { hasAvailability: false, slots: [], availableSlots: [] }
  );
});
```

- [ ] **Step 2: 跑测试**

Run: `cd server; npm test`

Expected: 9/9 pass.

- [ ] **Step 3: Commit**

```powershell
git add server/test/hbfy-dept-date.test.js
git commit -m "test(server): cover hbfy status=1 and unknown-status callbacks"
```

---

## Task 5: 接入 server.js — 改写 monitors 列表 + 配置别名

**Files:**
- Modify: `server/src/server.js:67-130`（monitors 数组 + legacyDoctorSourceConfigAliases）

- [ ] **Step 1: 替换 monitors 数组**

In `server/src/server.js`, replace lines 67-109 (the entire `const monitors = [...]` literal) with:

```js
const monitors = [
  {
    id: "lin-xingguang",
    doctorName: "林星光",
    hospitalName: "同济医院",
    campusName: "光谷院区",
    departmentName: "产科",
    registrationType: "专家号",
    enabled: true,
    hasAvailability: false,
    lastCheckedAt: new Date().toISOString(),
    lastResultSummary: "等待真实接口结果",
    priorityWindow: "16:50-17:10"
  },
  {
    id: "tu-wei",
    doctorName: "凃巍",
    hospitalName: "同济医院",
    campusName: "光谷+汉口",
    departmentName: "风湿免疫内科",
    registrationType: "专家号",
    enabled: true,
    hasAvailability: false,
    lastCheckedAt: new Date().toISOString(),
    lastResultSummary: "等待真实接口结果",
    priorityWindow: "16:50-17:10"
  },
  {
    id: "hbfy-guanggu-chaosheng",
    doctorName: "妇幼超声",
    hospitalName: "湖北省妇幼-光谷",
    campusName: "光谷院区",
    departmentName: "超声诊断科 专家门诊",
    registrationType: "专家号",
    enabled: true,
    hasAvailability: false,
    lastCheckedAt: new Date().toISOString(),
    lastResultSummary: "等待真实接口结果",
    priorityWindow: "16:50-17:10"
  }
];
```

- [ ] **Step 2: 移除遗留别名**

In `server/src/server.js`, replace lines 121-130 (the `legacyDoctorSourceConfigAliases` object) with:

```js
const legacyDoctorSourceConfigAliases = {};
```

Rationale: 新 monitor ID 直接命中 `HOSPITAL_DOCTOR_SOURCE_CONFIG_JSON`，不再需要别名。

- [ ] **Step 3: 启动 server 验证不报错**

Run: `cd server; npm run dev`

Expected: 看到 `号来了后端已启动：http://127.0.0.1:3000`，无报错。Ctrl+C 退出。

- [ ] **Step 4: Commit**

```powershell
git add server/src/server.js
git commit -m "feat(server): replace monitors list with new 3-card layout (lin-xingguang/tu-wei/hbfy)"
```

---

## Task 6: 接入 server.js — 新增同济 v2 + 妇幼分发逻辑

**Files:**
- Modify: `server/src/server.js`（在 `queryHospitalAvailability` 上方插入新函数；改写 `queryHospitalAvailability`）

- [ ] **Step 1: 在文件顶部导入解析器**

Add to `server/src/server.js` after line 4:

```js
import { parseTjhappV2 } from "./parsers/tjhapp-v2.js";
import { parseHbfyDeptDate } from "./parsers/hbfy-dept-date.js";
```

- [ ] **Step 2: 加同济 v2 查询函数**

In `server/src/server.js`, insert before `async function queryHospitalAvailability(monitor)` (currently at line 1117):

```js
async function queryTjhappV2(monitor) {
  const sourceConfig = getDoctorSourceConfig(monitor.id);
  const request = sourceConfig.request || {};
  const filter = sourceConfig.filter || {};

  const uname = process.env.HOSPITAL_TJH_UNAME || "";
  const uuid = process.env.HOSPITAL_TJH_UUID || "";
  const ukey = process.env.HOSPITAL_TJH_UKEY || "";
  const token = process.env.HOSPITAL_TJH_TOKEN || "";

  if (!uname || !uuid || !ukey || !token) {
    return {
      ok: false,
      error: "tjh_credentials_missing",
      message: "HOSPITAL_TJH_UNAME/UUID/UKEY/TOKEN 未配置，无法访问同济新接口"
    };
  }

  const body = new URLSearchParams({
    yqcode1: String(request.yqcode1 || ""),
    kscode1: String(request.kscode1 || ""),
    doctorCode: String(request.doctorCode || ""),
    scheduleType: "",
    laterThan17: "true"
  }).toString();

  const startedAt = Date.now();
  try {
    const response = await fetch("https://tjhapp.com.cn:8013/yuyue/getdocinfoNewV2", {
      method: "POST",
      headers: {
        "plan": "wxapp",
        "uname": uname,
        "uuid": uuid,
        "ukey": ukey,
        "token": token,
        "X-Requested-With": "XMLHttpRequest",
        "Origin": "https://tjhapp.com.cn",
        "Referer": "https://tjhapp.com.cn/",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        latencyMs,
        error: "tjh_http_error",
        message: `同济接口返回 HTTP ${response.status}（鉴权过期或参数错误，请更新 .env）`
      };
    }
    const payload = await response.json();
    if (payload?.success === false) {
      return {
        ok: false,
        latencyMs,
        error: "tjh_api_error",
        message: payload?.msg || "同济接口 success=false（可能鉴权过期，请更新 .env）"
      };
    }

    const parsed = parseTjhappV2(payload, {
      monitorId: monitor.id,
      doctorName: monitor.doctorName,
      departmentName: monitor.departmentName,
      filter
    });
    return {
      ok: true,
      status: response.status,
      latencyMs,
      hasAvailability: parsed.hasAvailability,
      slots: parsed.slots,
      availableSlots: parsed.availableSlots,
      request: { url: "tjhapp/getdocinfoNewV2", method: "POST" }
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: "tjh_fetch_failed",
      message: error.message
    };
  }
}
```

- [ ] **Step 3: 加妇幼 14 天并行查询函数**

Insert immediately after `queryTjhappV2`:

```js
function buildHbfyDateList(windowDays) {
  const days = Math.max(1, Number(windowDays || 14));
  const dates = [];
  const today = new Date();
  for (let i = 0; i < days; i += 1) {
    const target = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
    dates.push(formatShanghaiDate(target));
  }
  return dates;
}

async function fetchHbfyForDate(outpDate, request, monitorId) {
  const url = new URL("https://hbfy3.hbfy.com/Micro04/reservegh");
  url.searchParams.set("cls", "yygh");
  url.searchParams.set("m", "geteffdoctorlistext");
  url.searchParams.set("choiceType", String(request.choiceType || "1"));
  url.searchParams.set("deptCode", String(request.deptCode || ""));
  url.searchParams.set("deptLevel", String(request.deptLevel || "2"));
  url.searchParams.set("doctType", String(request.doctType || "2"));
  url.searchParams.set("funcId", String(request.funcId || "function03"));
  url.searchParams.set("parentId", String(request.parentId || request.deptCode || ""));
  url.searchParams.set("outpDate", outpDate);

  const response = await fetch(url.toString(), { method: "GET" });
  if (!response.ok) {
    throw new Error(`hbfy_http_${response.status}`);
  }
  const payload = await response.json();
  return parseHbfyDeptDate(payload, {
    monitorId,
    outpDate,
    filter: { excludeStatuses: ["2"] },
    onUnknownStatus: (status) => {
      logWithShanghaiTime(`妇幼未知 status：${monitorId} outpDate=${outpDate} status=${status}`);
    }
  });
}

async function queryHbfyDeptDate(monitor) {
  const sourceConfig = getDoctorSourceConfig(monitor.id);
  const request = sourceConfig.request || {};
  const windowDays = Number(sourceConfig.windowDays || process.env.HOSPITAL_HBFY_WINDOW_DAYS || 14);
  const dates = buildHbfyDateList(windowDays);
  const startedAt = Date.now();

  const settled = await Promise.allSettled(
    dates.map((date) => fetchHbfyForDate(date, request, monitor.id))
  );
  const latencyMs = Date.now() - startedAt;
  const slots = [];
  const failures = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      slots.push(...result.value.slots);
    } else {
      failures.push(`${dates[index]}:${result.reason?.message || result.reason}`);
    }
  });

  if (failures.length === dates.length) {
    return {
      ok: false,
      latencyMs,
      error: "hbfy_all_failed",
      message: `妇幼接口全部失败：${failures.slice(0, 3).join("; ")}`
    };
  }

  if (failures.length > 0) {
    logWithShanghaiTime(`妇幼部分日期失败：${failures.join("; ")}`);
  }

  slots.sort((left, right) => {
    return [
      String(left.visitDate || "").localeCompare(String(right.visitDate || "")),
      String(left.durationCode || "").localeCompare(String(right.durationCode || "")),
      String(left.doctorCode || "").localeCompare(String(right.doctorCode || ""))
    ].find((v) => v !== 0) || 0;
  });
  const availableSlots = slots.filter((slot) => slot.available);

  return {
    ok: true,
    latencyMs,
    hasAvailability: availableSlots.length > 0,
    slots,
    availableSlots,
    request: { url: "hbfy/Micro04/reservegh", method: "GET" },
    sourceResults: dates.map((date, index) => ({
      outpDate: date,
      ok: settled[index].status === "fulfilled"
    }))
  };
}
```

- [ ] **Step 4: 改写 queryHospitalAvailability 为按 parser 分发**

Replace the entire body of `queryHospitalAvailability` (lines 1117-1131) with:

```js
async function queryHospitalAvailability(monitor) {
  const sourceConfig = getDoctorSourceConfig(monitor.id);
  const parser = sourceConfig.parser || "";

  if (parser === "tjhapp_v2") {
    return queryTjhappV2(monitor);
  }

  if (parser === "hbfy_dept_date") {
    return queryHbfyDeptDate(monitor);
  }

  const sourceConfigs = normalizeDoctorSourceConfigs(monitor.id);
  if (sourceConfigs.length === 1) {
    return queryHospitalAvailabilitySource(monitor, sourceConfigs[0]);
  }

  const results = await Promise.all(
    sourceConfigs.map(async (config, index) => {
      const result = await queryHospitalAvailabilitySource(monitor, config);
      logWithShanghaiTime(`真实接口分源结果：${monitor.doctorName} | ${getSourceLabel(config, index)} | ok=${result.ok} | 排班=${Array.isArray(result.slots) ? result.slots.length : 0} | 可约=${Array.isArray(result.availableSlots) ? result.availableSlots.length : 0}`);
      return result;
    })
  );
  return mergeHospitalAvailabilityResults(results);
}
```

- [ ] **Step 5: 启动 server 验证编译通过**

Run: `cd server; npm run dev`

Expected: 启动成功，无 import / syntax 错误。Ctrl+C 退出。

- [ ] **Step 6: Commit**

```powershell
git add server/src/server.js
git commit -m "feat(server): dispatch to tjhapp_v2 / hbfy_dept_date based on monitor parser"
```

---

## Task 7: 更新通知 helpers — alertTip 和 notificationKey

**Files:**
- Modify: `server/src/server.js`（`getSlotNotificationKey`、`buildSubscribeAlertTip`）

- [ ] **Step 1: 让 getSlotNotificationKey 优先使用 slot.notificationKey**

In `server/src/server.js`, replace `getSlotNotificationKey` (lines 590-605) with:

```js
function getSlotNotificationKey(monitor, slot) {
  if (slot.notificationKey) {
    return slot.notificationKey;
  }

  const scheduleId = String(slot.scheduleId || "").trim();
  if (scheduleId) {
    return `${monitor.id}:schedule:${scheduleId}`;
  }

  return [
    monitor.id,
    slot.hospitalId || monitor.hospitalId || monitor.campusName || "",
    slot.doctorCode || "",
    slot.visitDate || "",
    slot.durationCode || slot.durationName || "",
    slot.specCode || slot.specName || "",
    slot.regTypeCode || slot.regTypeName || ""
  ].map((item) => String(item)).join("|");
}
```

- [ ] **Step 2: 让 buildSubscribeAlertTip 支持多医院 / 多医生**

Replace `buildSubscribeAlertTip` (lines 575-588) with:

```js
function buildSubscribeAlertTip(monitor) {
  if (monitor.alertTip) {
    return monitor.alertTip;
  }

  const slot = Array.isArray(monitor.availableSlots) ? monitor.availableSlots[0] : null;
  if (!slot) {
    return `${monitor.doctorName || "号源"}有号，请速看。`;
  }

  const doctorName = slot.doctorName || monitor.doctorName || "";
  const campus = slot.hospitalName ? `${slot.hospitalName} ` : "";
  const timeText = `${slot.visitDate || ""} ${slot.weekday || ""} ${slot.durationName || ""}`.trim();
  const priceText = slot.regPrice ? `，挂号费${slot.regPrice}元` : "";
  return `${doctorName}${campus ? " " + campus : ""}${timeText}有号${priceText}，请速看。`.trim();
}
```

- [ ] **Step 3: Commit**

```powershell
git add server/src/server.js
git commit -m "feat(server): use slot.notificationKey when present; alertTip includes campus and slot doctorName"
```

---

## Task 8: 更新 .env.example

**Files:**
- Modify: `server/.env.example`

- [ ] **Step 1: 重写 .env.example**

Replace the entire content of `server/.env.example` with:

```bash
# -----------------------------------------------------------------------------
# 号来了 后端配置示例
# 复制为 server/.env 并按需填写。请勿把 .env 提交到 Git。
# -----------------------------------------------------------------------------

PORT=3000
HOST=127.0.0.1

# 微信小程序
WECHAT_APP_ID=wx3d8692defee95f21
WECHAT_APP_SECRET=

# 订阅消息模板 ID（公众平台申请）；多个用英文逗号分隔，取第一个用于发送
WECHAT_SUBSCRIBE_TEMPLATE_ID=
# 候补成功模板字段：time1=候补成功时间，short_thing2=候补节点，thing3=温馨提示
# 占位符：doctorName hospitalName campusName departmentName registrationType monitorId checkedAt availabilityTime alertTip
WECHAT_SUBSCRIBE_TEMPLATE_DATA_JSON={"time1":{"value":"{{availabilityTime}}"},"short_thing2":{"value":"{{doctorName}}"},"thing3":{"value":"{{alertTip}}"}}
WECHAT_SUBSCRIBE_PAGE=pages/index/index
WECHAT_SUBSCRIBE_MINIPROGRAM_STATE=formal

# 登录白名单：非空时仅这些 openid 可订阅 & 接收提醒
ALLOWED_OPENIDS=
# 额外持久通知名单（可选，逗号分隔）；用户点订阅按钮也会写入 server/data/notify-openids.json
NOTIFY_OPENIDS=

# 监控窗口（妇幼按日期查询时使用 HOSPITAL_HBFY_WINDOW_DAYS）
MONITOR_WINDOW_DAYS=14
HOSPITAL_API_ENABLED=true
DEBUG_RAW_HOSPITAL_RESPONSE=false

# -----------------------------------------------------------------------------
# 同济新接口（tjhapp.com.cn:8013）鉴权 - 从抓包获取，token/ukey 过期后手动更新
# -----------------------------------------------------------------------------
HOSPITAL_TJH_UNAME=
HOSPITAL_TJH_UUID=
HOSPITAL_TJH_UKEY=
HOSPITAL_TJH_TOKEN=

# -----------------------------------------------------------------------------
# 湖北省妇幼接口（hbfy3.hbfy.com）- 当前无鉴权
# -----------------------------------------------------------------------------
HOSPITAL_HBFY_WINDOW_DAYS=14

# -----------------------------------------------------------------------------
# Monitor 配置：parser 字段决定走哪条解析路径
# -----------------------------------------------------------------------------
HOSPITAL_DOCTOR_SOURCE_CONFIG_JSON={"lin-xingguang":{"parser":"tjhapp_v2","request":{"yqcode1":"270018","kscode1":"02030201","doctorCode":"101573"},"filter":{"hospitaldm":["270018"],"deptCode":["020302"],"yystatus":["可约"]}},"tu-wei":{"parser":"tjhapp_v2","request":{"yqcode1":"270018","kscode1":"02010801","doctorCode":"101110"},"filter":{"hospitaldm":["270017","270018"],"deptCode":["010108"],"yystatus":["可约"]}},"hbfy-guanggu-chaosheng":{"parser":"hbfy_dept_date","request":{"deptCode":"633","deptLevel":"2","doctType":"2","funcId":"function03","parentId":"633","choiceType":"1"},"windowDays":14,"filter":{"excludeStatuses":["2"]}}}

# 自动轮询
MONITOR_AUTO_POLL_ENABLED=false
MONITOR_PRIORITY_START=16:50
MONITOR_PRIORITY_END=17:10
MONITOR_PRIORITY_MIN_SECONDS=1
MONITOR_PRIORITY_MAX_SECONDS=5
MONITOR_NORMAL_MIN_MINUTES=1
MONITOR_NORMAL_MAX_MINUTES=10

# 开发调试：mock 模式下也在 false->true 时发订阅（正式勿开）
NOTIFY_ON_MOCK_TRANSITION=false
```

- [ ] **Step 2: Commit**

```powershell
git add server/.env.example
git commit -m "chore(server): rewrite .env.example for tjhapp_v2 + hbfy parsers"
```

---

## Task 9: 后端冒烟测试

**Files:** None (verification only)

- [ ] **Step 1: 跑全部单元测试**

Run: `cd server; npm test`

Expected: 9/9 pass (4 tjhapp_v2 + 5 hbfy_dept_date).

- [ ] **Step 2: 创建本地 .env（不要 commit）**

Create `server/.env` (NOT `.env.example`)，复制 `.env.example` 内容，填入：
- `HOSPITAL_TJH_UNAME=<你的手机号>`
- `HOSPITAL_TJH_UUID=<你的 uuid>`
- `HOSPITAL_TJH_UKEY=<你的 ukey>`
- `HOSPITAL_TJH_TOKEN=<你的 token>`

把 `WECHAT_APP_SECRET` 也填上。

如果还不想真实联网，可以暂时把 `HOSPITAL_API_ENABLED=false` 走 mock 模式。

- [ ] **Step 3: 启动 server**

Run: `cd server; npm run dev`

Expected: 启动日志显示 `号来了后端已启动：http://127.0.0.1:3000`。

- [ ] **Step 4: 验证 /api/monitors 返回 3 个 monitor**

In a new PowerShell window:

Run: `Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/monitors" | ConvertTo-Json -Depth 4`

Expected: 返回 JSON 包含 3 个 monitor，id 分别为 `lin-xingguang`、`tu-wei`、`hbfy-guanggu-chaosheng`。

- [ ] **Step 5: 触发一次手动 tick**

Run: `Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/monitor/tick?notify=false" -Method POST | ConvertTo-Json -Depth 5`

Expected: 
- 如果填了真实 `.env`：3 个 monitor 都返回 `ok: true`、`slots` 数组（长度可能为 0 但不报错）
- 如果 token 过期：林星光/凃巍返回 `error: "tjh_http_error"` 或 `"tjh_api_error"`，`lastResultSummary` 显示"鉴权过期"。`hbfy-guanggu-chaosheng` 应能正常返回（妇幼无鉴权）

- [ ] **Step 6: 验证妇幼 debug endpoint**

Run: `Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/hospital/debug-availability?id=hbfy-guanggu-chaosheng" | ConvertTo-Json -Depth 5`

Expected: `ok: true`，`slots[]` 非空（取决于当下排班），所有 slot 的 `doctorName` 字段非空。

- [ ] **Step 7: 停掉 server，commit（如果有改动）**

如果 Step 5/6 暴露 bug，回头修代码并加测试，然后 commit。否则跳过 commit。

---

## Task 10: Miniapp index 页 — 卡片展示可约号源清单

**Files:**
- Modify: `miniapp/pages/index/index.js`
- Modify: `miniapp/pages/index/index.wxml`
- Modify: `miniapp/pages/index/index.wxss`

- [ ] **Step 1: 在 index.js 里把 availableSlots 拍平成可显示行**

Replace the `loadMonitors` `success` callback (lines 58-80) with:

```js
      success: (res) => {
        const payload = res.data || {};
        const monitors = (payload.monitors || []).map((item) => {
          const availableSlots = Array.isArray(item.availableSlots) ? item.availableSlots : [];
          const slotRows = availableSlots.map((slot) => {
            const segments = [];
            if (slot.hospitalName) segments.push(slot.hospitalName);
            if (slot.doctorName) segments.push(slot.doctorName);
            const meta = segments.join(" · ");
            const price = slot.regPrice ? ` ¥${slot.regPrice}` : "";
            return {
              key: slot.notificationKey || `${slot.visitDate}-${slot.durationName}-${slot.doctorCode || ""}`,
              text: `${slot.visitDate} ${slot.weekday || ""} ${slot.durationName || ""}${meta ? "  " + meta : ""}${price}`.trim()
            };
          });
          return {
            ...item,
            statusText: item.hasAvailability ? "有号" : item.enabled ? "监控中" : "已暂停",
            statusClass: item.hasAvailability ? "status-found" : item.enabled ? "status-ok" : "status-paused",
            lastCheckedAtText: formatTime(item.lastCheckedAt),
            slotRows
          };
        });
        const lastCheckedAt = monitors
          .map((item) => item.lastCheckedAt)
          .filter(Boolean)
          .sort()
          .pop();

        this.setData({
          loading: false,
          systemStatus: "正常",
          monitors,
          windowDays: payload.windowDays || "-",
          enabledCount: monitors.filter((item) => item.enabled).length,
          lastCheckedText: formatTime(lastCheckedAt)
        });
      },
```

- [ ] **Step 2: 在 index.wxml 卡片里渲染 slotRows**

Replace the `<view wx:else>...</view>` block (lines 35-51) with:

```xml
  <view wx:else>
    <view wx:for="{{monitors}}" wx:key="id" class="doctor-card" bindtap="openDetail" data-id="{{item.id}}">
      <view class="doctor-main">
        <view>
          <view class="doctor-name">{{item.doctorName}}</view>
          <view class="doctor-meta">{{item.departmentName}} · {{item.campusName}}</view>
        </view>
        <view class="status {{item.statusClass}}">{{item.statusText}}</view>
      </view>
      <view wx:if="{{item.slotRows.length}}" class="slot-list">
        <view wx:for="{{item.slotRows}}" wx:for-item="row" wx:key="key" class="slot-row">{{row.text}}</view>
      </view>
      <view wx:else class="result">{{item.lastResultSummary || "暂无可约"}}</view>
      <view class="doctor-footer">
        <text>最近检查：{{item.lastCheckedAtText}}</text>
        <text>{{item.enabled ? "监控中" : "已暂停"}}</text>
      </view>
    </view>
  </view>
```

- [ ] **Step 3: 在 index.wxss 加 slot-list 样式**

Append to `miniapp/pages/index/index.wxss`:

```css
.slot-list {
  margin-top: 16rpx;
  padding: 14rpx 16rpx;
  border-radius: 8rpx;
  background: #f0fdf4;
  border: 1rpx solid #bbf7d0;
}

.slot-row {
  margin: 4rpx 0;
  color: #166534;
  font-size: 26rpx;
  line-height: 1.6;
}
```

- [ ] **Step 4: 在微信开发者工具里预览首页**

打开微信开发者工具 → 项目目录指向 `F:\chen\haolaile\miniapp\` → 编译。

确认：
- 看到 3 张卡片：林星光、凃巍、妇幼超声
- 「监控中」状态正常显示
- 如果后端有可约数据，卡片下方出现绿色背景的号源清单
- 没有可约时显示原来的 `lastResultSummary`

- [ ] **Step 5: Commit**

```powershell
git add miniapp/pages/index/
git commit -m "feat(miniapp): show available slot list on home cards"
```

---

## Task 11: Miniapp detail 页 — 适配新字段

**Files:**
- Modify: `miniapp/pages/detail/detail.js`
- Modify: `miniapp/pages/detail/detail.wxml`

- [ ] **Step 1: 调整 statusClass 映射兼容新数据**

In `miniapp/pages/detail/detail.js`, replace the `scheduleRows` mapping (lines 61-73):

```js
        const scheduleRows = (monitor.slots || []).map((slot, index) => {
          const status = String(slot.availableStatus || "");
          let statusClass = "schedule-full";
          if (slot.available) {
            statusClass = "schedule-available";
          } else if (status === "3" || status === "停诊") {
            statusClass = "schedule-stopped";
          } else if (status === "4" || status === "过期") {
            statusClass = "schedule-expired";
          }
          return {
            ...slot,
            statusClass,
            rowKey: slot.notificationKey || slot.scheduleId || `${slot.visitDate}-${slot.durationName}-${index}`
          };
        });
```

- [ ] **Step 2: 改 wxml 的 key 和增加字段展示**

In `miniapp/pages/detail/detail.wxml`, replace the schedule-row block (lines 20-26):

```xml
    <view wx:for="{{scheduleRows}}" wx:key="rowKey" class="schedule-row">
      <view>
        <view class="schedule-date">{{item.visitDate}} {{item.weekday}}</view>
        <view class="schedule-meta">
          {{item.durationName}}
          <text wx:if="{{item.hospitalName}}"> · {{item.hospitalName}}</text>
          <text wx:if="{{item.doctorName}}"> · {{item.doctorName}}</text>
          <text wx:if="{{item.regPrice}}"> · ¥{{item.regPrice}}</text>
        </view>
      </view>
      <view class="schedule-status {{item.statusClass}}">{{item.availableStatusName}}</view>
    </view>
```

- [ ] **Step 3: 微信开发者工具里点进任一卡片验证**

确认：
- 详情页头部显示 monitor 信息（科室/院区/号源类型）
- 排班列表正常显示，每行带日期 / 上下午 / 院区或医生 / 价格 / 状态文字
- 没有报 `Cannot read property of undefined`

- [ ] **Step 4: Commit**

```powershell
git add miniapp/pages/detail/
git commit -m "feat(miniapp): adapt detail slot rows to multi-campus and hbfy fields"
```

---

## Task 12: Miniapp settings 页 — 更新 monitor 列表文案

**Files:**
- Modify: `miniapp/pages/settings/settings.wxml`

- [ ] **Step 1: 替换 todo 列表**

Replace the `<view class="panel">` block containing `监控配置` (lines 9-17) with:

```xml
  <view class="panel">
    <view class="section-title">监控配置</view>
    <view class="todo">林星光 · 同济光谷 · 产科 · 仅 deptCode=020302</view>
    <view class="todo">凃巍 · 同济光谷+汉口 · 风湿免疫内科 · 仅 deptCode=010108</view>
    <view class="todo">湖北省妇幼-光谷 · 超声诊断科 专家门诊 · 全部医生</view>
    <view class="todo">未来 14 天滚动窗口</view>
    <view class="todo">重点时段 16:50-17:10</view>
  </view>
```

- [ ] **Step 2: 微信开发者工具里打开设置页验证**

打开「设置」页面，确认：
- 看到 3 行 monitor 描述（与上面一致）
- 「通知成员」面板保留原样

- [ ] **Step 3: Commit**

```powershell
git add miniapp/pages/settings/
git commit -m "feat(miniapp): update settings page monitor list for new config"
```

---

## Task 13: 端到端冒烟（联调）

**Files:** None (manual verification)

- [ ] **Step 1: 后端启动**

确保 `server/.env` 已配好真实凭证。

Run: `cd server; npm run dev`

- [ ] **Step 2: 触发一次有提醒的 tick（NOTIFY_ON_MOCK_TRANSITION 关掉，避免 mock 推送）**

Run: `Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/monitor/tick?notify=true" -Method POST | ConvertTo-Json -Depth 5`

- [ ] **Step 3: 检查 server stdout 日志**

应能看到：
- 「监控查询开始：trigger=api」
- 3 行「监控查询结果：林星光 / 凃巍 / 妇幼超声」
- 「监控查询结束：trigger=api count=3」

如果任一 monitor 出错，按 `lastResultSummary` 提示修正：
- 同济：检查 `.env` 里 `HOSPITAL_TJH_*` 是否都填了，且未过期
- 妇幼：检查网络可达性（GET 请求应该能 200）

- [ ] **Step 4: 小程序首页刷新**

在微信开发者工具里点「刷新」按钮，确认 3 张卡片显示正确。

- [ ] **Step 5: 测试订阅消息（可选）**

如果你想验证订阅推送功能，先在详情页点「订阅有号提醒」，然后：

Run: `Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/notify/test?id=hbfy-guanggu-chaosheng" -Method POST | ConvertTo-Json`

Expected: 微信收到一条测试订阅消息。

- [ ] **Step 6: 全部成功后停 server**

Ctrl+C，验收完成。

---

## Self-Review

**1. Spec coverage**:
- §2 监控配置（3 张卡片）→ Task 5 + Task 8（env 配置） + Task 12（settings UI）✓
- §3 同济适配层 → Task 1 + Task 2 + Task 6（dispatch）✓
- §4 湖北省妇幼适配层 → Task 3 + Task 4 + Task 6（dispatch、14 日并行）✓
- §5 后端结构调整（旧 parseTjhRegSources 保留）→ Task 6（只替换 dispatch，未删旧函数）✓
- §6 前端 UI → Task 10（首页可约清单）+ Task 11（详情页字段适配）+ Task 12（设置页）✓
- §7 .env 变更 → Task 8 ✓
- §8 推送文案 → Task 7 ✓
- §9 轮询不动 → 无须改动 ✓
- §10 验证 → Task 9 + Task 13 ✓
- §11 风险 1（同济鉴权过期）→ Task 6 的 `queryTjhappV2` 已处理：返回 `tjh_http_error`/`tjh_api_error` 并在 `lastResultSummary` 暴露提示 ✓
- §11 风险 2（妇幼 status=1 含义未确认）→ Task 3+4 的 `onUnknownStatus` 回调 + Task 6 的 logWithShanghaiTime warn ✓

**2. Placeholder scan**: 无 TBD/TODO；所有代码 step 都给出完整代码块；命令都是可直接执行的 PowerShell/git 命令。

**3. Type consistency**:
- `parseTjhappV2(payload, options)` — options 含 `monitorId/doctorName/departmentName/filter`（Tasks 1-2、6 一致）
- `parseHbfyDeptDate(payload, options)` — options 含 `monitorId/outpDate/filter/onUnknownStatus`（Tasks 3-4、6 一致）
- Slot shape 一致：`available/availableStatus/availableStatusName/scheduleId/doctorCode/doctorName/hospitalId/hospitalName/deptCode/deptName/departmentName/visitDate/weekday/durationCode/durationName/regTypeCode/regTypeName/regPrice/specCode/specName/notificationKey`（两个 parser 都生成；server.js/miniapp 都读这些字段）✓
