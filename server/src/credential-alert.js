// 识别"需要人工更新凭证"的失败：妇幼会话失效 / 同济鉴权过期 / 凭证缺失。
// 这些错误轮询会持续出现，所以用"健康<->失效"的边沿判断，只在翻转时提醒一次，
// 避免每个 tick（1-10 分钟一次）反复刷屏。网络抖动类（如 hbfy_all_failed）不在此列。
export const CREDENTIAL_ALERT_ERRORS = new Set([
  "hbfy_session_invalid",
  "hbfy_cookie_missing",
  "tjh_credentials_missing",
  "tjh_http_error",
  "tjh_api_error"
]);

export function isCredentialFailure(payload) {
  return CREDENTIAL_ALERT_ERRORS.has(payload && payload.lastError);
}

// prevFailed: 上一次该 monitor 是否处于凭证失效态
// 返回 { failed, edge }：edge="failed" 表示刚从健康转为失效，"recovered" 表示刚恢复，null 表示无翻转
export function classifyCredentialEdge(prevFailed, payload) {
  const failed = isCredentialFailure(payload);
  let edge = null;
  if (failed && !prevFailed) edge = "failed";
  else if (!failed && prevFailed) edge = "recovered";
  return { failed, edge };
}
