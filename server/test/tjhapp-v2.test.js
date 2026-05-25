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
