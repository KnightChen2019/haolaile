import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHbfyDeptDate, classifyHbfyResponse, normalizeHbfyCookie } from "../src/parsers/hbfy-dept-date.js";

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

test("parseHbfyDeptDate: 未知 status 触发回调且默认不可约", () => {
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
    onUnknownStatus: (status) => {
      captured = status;
    }
  });

  assert.equal(captured, "0", "应触发 onUnknownStatus 回调");
  assert.equal(result.hasAvailability, false, "未知 status 默认不可约，避免误报刷屏");
  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0].available, false);
  assert.equal(result.slots[0].availableStatusName, "status=0");
});

test("parseHbfyDeptDate: status=7 约满、status=3 停诊 均不可约", () => {
  const payload = {
    doclist: [
      {
        doctor_no: "DOC-MAN",
        doctor_name: "范建华",
        scheduleExtInfo: {
          outpDate: "2026-06-02",
          morning: { status: "7", value: "专家号", fee: "21.5", scheduleInfo: { scheduleId: "S-MAN-AM" } },
          afternoon: { status: "7", value: "专家号", fee: "21.5", scheduleInfo: { scheduleId: "S-MAN-PM" } }
        }
      },
      {
        doctor_no: "DOC-STOP",
        doctor_name: "李建华",
        scheduleExtInfo: {
          outpDate: "2026-06-02",
          morning: { status: "3", value: "专家号", fee: "14.5", scheduleInfo: { scheduleId: "S-STOP-AM" } },
          afternoon: null
        }
      }
    ]
  };

  let unknownCalls = 0;
  const result = parseHbfyDeptDate(payload, {
    monitorId: "hbfy-guanggu-chaosheng",
    outpDate: "2026-06-02",
    onUnknownStatus: () => {
      unknownCalls += 1;
    }
  });

  assert.equal(unknownCalls, 0, "7/3 是已知状态，不应触发未知回调");
  assert.equal(result.hasAvailability, false);
  assert.equal(result.availableSlots.length, 0);
  assert.equal(result.slots.length, 3);

  const man = result.slots.find((slot) => slot.scheduleId === "S-MAN-AM");
  assert.equal(man.available, false);
  assert.equal(man.availableStatusName, "约满");

  const stop = result.slots.find((slot) => slot.scheduleId === "S-STOP-AM");
  assert.equal(stop.available, false);
  assert.equal(stop.availableStatusName, "停诊");
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

test("normalizeHbfyCookie: 裸 session id 自动补 JSESSIONID= 前缀", () => {
  assert.equal(normalizeHbfyCookie("E217E7CB5C68"), "JSESSIONID=E217E7CB5C68");
  assert.equal(normalizeHbfyCookie("  E217E7CB5C68  "), "JSESSIONID=E217E7CB5C68");
  assert.equal(normalizeHbfyCookie("JSESSIONID=E217E7CB5C68"), "JSESSIONID=E217E7CB5C68");
  assert.equal(normalizeHbfyCookie("JSESSIONID=E217E7CB5C68; Secure"), "JSESSIONID=E217E7CB5C68; Secure");
  assert.equal(normalizeHbfyCookie(""), "");
  assert.equal(normalizeHbfyCookie(undefined), "");
});

test("classifyHbfyResponse: 区分成功/会话失效/空排班/未知", () => {
  assert.equal(classifyHbfyResponse({ rc: 1, doclist: [] }), "ok");
  assert.equal(classifyHbfyResponse({ rc: -1, msg: "获取医生异常!" }), "session_invalid");
  assert.equal(classifyHbfyResponse({ rc: -1, msg: "获取医生白班返回为空!" }), "empty");
  assert.equal(classifyHbfyResponse({ rc: -1, msg: "某种新错误" }), "unknown");
  assert.equal(classifyHbfyResponse(null), "unknown");
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
