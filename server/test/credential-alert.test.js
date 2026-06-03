import { test } from "node:test";
import assert from "node:assert/strict";
import { isCredentialFailure, classifyCredentialEdge } from "../src/credential-alert.js";

test("isCredentialFailure: 识别需人工更新凭证的错误", () => {
  assert.equal(isCredentialFailure({ lastError: "hbfy_session_invalid" }), true);
  assert.equal(isCredentialFailure({ lastError: "hbfy_cookie_missing" }), true);
  assert.equal(isCredentialFailure({ lastError: "tjh_credentials_missing" }), true);
  assert.equal(isCredentialFailure({ lastError: "tjh_http_error" }), true);
  assert.equal(isCredentialFailure({ lastError: "tjh_api_error" }), true);
  // 非凭证类失败（网络/全部失败）不应触发"更新凭证"提醒
  assert.equal(isCredentialFailure({ lastError: "hbfy_all_failed" }), false);
  assert.equal(isCredentialFailure({}), false);
  assert.equal(isCredentialFailure(null), false);
});

test("classifyCredentialEdge: 仅在健康<->失效翻转时给出边沿", () => {
  const bad = { lastError: "hbfy_session_invalid" };
  const ok = { lastError: undefined };
  assert.deepEqual(classifyCredentialEdge(false, bad), { failed: true, edge: "failed" });
  assert.deepEqual(classifyCredentialEdge(true, bad), { failed: true, edge: null });
  assert.deepEqual(classifyCredentialEdge(true, ok), { failed: false, edge: "recovered" });
  assert.deepEqual(classifyCredentialEdge(false, ok), { failed: false, edge: null });
});
