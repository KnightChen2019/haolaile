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
