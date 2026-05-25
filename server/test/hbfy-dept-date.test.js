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
