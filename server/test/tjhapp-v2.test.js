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

const tuWeiFixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/tjhapp-v2-tu-wei.json"), "utf8")
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
  assert.equal(
    result.slots.every((slot) => slot.doctorName === "林星光"),
    true,
    "所有 slot 的 doctorName 应来自 payload.datainfo.doctorName"
  );
});

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
