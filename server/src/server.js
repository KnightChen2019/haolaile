import http from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTjhappV2 } from "./parsers/tjhapp-v2.js";
import { parseHbfyDeptDate } from "./parsers/hbfy-dept-date.js";

function loadEnvFile(envPath) {
  if (!existsSync(envPath)) {
    return;
  }

  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key && (process.env[key] === undefined || (process.env[key] === "" && value !== ""))) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

function loadEnv() {
  loadEnvFile(join(process.cwd(), "server", ".env"));
  loadEnvFile(join(process.cwd(), ".env"));
}

loadEnv();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const appId = process.env.WECHAT_APP_ID || "wx3d8692defee95f21";
const appSecret = process.env.WECHAT_APP_SECRET || "";
const hospitalApiEnabled = process.env.HOSPITAL_API_ENABLED === "true";
const allowedOpenids = new Set(
  (process.env.ALLOWED_OPENIDS || "")
    .split(",")
    .map((openid) => openid.trim())
    .filter(Boolean)
);

const notifyOpenidsFromEnv = new Set(
  (process.env.NOTIFY_OPENIDS || "")
    .split(",")
    .map((openid) => openid.trim())
    .filter(Boolean)
);
const dataDir = process.env.DATA_DIR || (existsSync(join(process.cwd(), "server")) ? join(process.cwd(), "server", "data") : join(process.cwd(), "data"));
const notifyOpenidsPath = join(dataDir, "notify-openids.json");
const notifiedSlotsPath = join(dataDir, "notified-slots.json");
const registeredNotifyOpenids = loadRegisteredNotifyOpenids();
const notifiedSlotRecords = loadNotifiedSlotRecords();
const previousMonitorAvailability = new Map();
let wechatApiTokenCache = { accessToken: "", expiresAt: 0 };
const hospitalAccessTokenCache = new Map();
let monitorTimer = null;
let monitorInFlight = false;

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

const monitorState = new Map(
  monitors.map((monitor) => [
    monitor.id,
    {
      ...monitor,
      sourceMode: hospitalApiEnabled ? "real" : "mock"
    }
  ])
);

const legacyDoctorSourceConfigAliases = {};

function parseJsonEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function loadRegisteredNotifyOpenids() {
  if (!existsSync(notifyOpenidsPath)) {
    return new Set();
  }

  try {
    const payload = JSON.parse(readFileSync(notifyOpenidsPath, "utf8"));
    if (!Array.isArray(payload.openids)) {
      return new Set();
    }
    return new Set(payload.openids.filter((openid) => typeof openid === "string" && openid.trim()));
  } catch {
    return new Set();
  }
}

function saveRegisteredNotifyOpenids() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    notifyOpenidsPath,
    JSON.stringify({ openids: [...registeredNotifyOpenids].sort() }, null, 2),
    "utf8"
  );
}

function loadNotifiedSlotRecords() {
  if (!existsSync(notifiedSlotsPath)) {
    return new Map();
  }

  try {
    const payload = JSON.parse(readFileSync(notifiedSlotsPath, "utf8"));
    if (!Array.isArray(payload.records)) {
      return new Map();
    }

    return new Map(
      payload.records
        .filter((record) => record && typeof record.key === "string" && record.key)
        .map((record) => [record.key, record])
    );
  } catch {
    return new Map();
  }
}

function saveNotifiedSlotRecords() {
  mkdirSync(dataDir, { recursive: true });
  const records = [...notifiedSlotRecords.values()].sort((left, right) => {
    return String(left.notifiedAt || "").localeCompare(String(right.notifiedAt || ""));
  });
  writeFileSync(notifiedSlotsPath, JSON.stringify({ records }, null, 2), "utf8");
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/([?&](?:access_token|token|session|sid|cookie|auth|authorization)=)[^&#]*/gi, "$1<redacted>")
    .replace(/("(?:access_token|token|session|sid|cookie|auth|authorization)"\s*:\s*")[^"]*(")/gi, "$1<redacted>$2")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>");
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys()) {
      if (/token|session|sid|cookie|auth|authorization/i.test(key)) {
        url.searchParams.set(key, "<redacted>");
      }
    }
    return url.toString();
  } catch {
    return redactSensitiveText(value);
  }
}

function replacePlaceholders(value, variables) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return variables[key] === undefined ? "" : String(variables[key]);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholders(item, variables));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replacePlaceholders(item, variables)])
    );
  }

  return value;
}

function clampTemplateValue(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function normalizeSubscribeTemplateData(data) {
  return Object.fromEntries(
    Object.entries(data).map(([key, item]) => {
      const value = item && typeof item === "object" ? item.value : item;
      const maxLength = key.startsWith("thing") || key.includes("_thing") ? 20 : 32;
      return [key, { value: clampTemplateValue(value, maxLength) }];
    })
  );
}

function getByPath(object, path) {
  if (!path || object === null || typeof object !== "object") {
    return undefined;
  }

  return path.split(".").reduce((current, segment) => {
    if (current === undefined || current === null) {
      return undefined;
    }
    return current[segment];
  }, object);
}

function tokenVariablesForMonitor(monitor, sourceConfig = getDoctorSourceConfig(monitor.id)) {
  const { startDate, endDate } = getMonitorDateRange();
  return {
    monitorId: monitor.id,
    doctorName: monitor.doctorName,
    departmentName: monitor.departmentName,
    campusName: monitor.campusName,
    registrationType: monitor.registrationType,
    hospitalName: monitor.hospitalName,
    windowDays: process.env.MONITOR_WINDOW_DAYS || "14",
    startDate,
    endDate,
    ...sourceConfig
  };
}

function formatShanghaiDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatShanghaiDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function getMonitorDateRange() {
  const windowDays = Math.max(1, Number(process.env.MONITOR_WINDOW_DAYS || 7));
  const now = new Date();
  const end = new Date(now.getTime() + (windowDays - 1) * 24 * 60 * 60 * 1000);
  return {
    startDate: formatShanghaiDate(now),
    endDate: formatShanghaiDate(end)
  };
}

function formatShanghaiWeekday(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "short"
  }).format(new Date(Number(timestamp)));
}

function minutesSinceMidnightInShanghai(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function parseTimeToMinutes(value) {
  const [hour, minute] = String(value).split(":").map((item) => Number(item));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return 0;
  }
  return hour * 60 + minute;
}

function isPriorityMonitorWindow(date = new Date()) {
  const start = parseTimeToMinutes(process.env.MONITOR_PRIORITY_START || "16:50");
  const end = parseTimeToMinutes(process.env.MONITOR_PRIORITY_END || "17:10");
  const now = minutesSinceMidnightInShanghai(date);
  return now >= start && now <= end;
}

function randomIntInclusive(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function nextMonitorDelayMs() {
  if (isPriorityMonitorWindow()) {
    const min = Math.max(1, Number(process.env.MONITOR_PRIORITY_MIN_SECONDS || 1));
    const max = Math.max(min, Number(process.env.MONITOR_PRIORITY_MAX_SECONDS || 5));
    return randomIntInclusive(min, max) * 1000;
  }

  const min = Math.max(1, Number(process.env.MONITOR_NORMAL_MIN_MINUTES || 1));
  const max = Math.max(min, Number(process.env.MONITOR_NORMAL_MAX_MINUTES || 10));
  return randomIntInclusive(min, max) * 60 * 1000;
}

function formatDelay(delayMs) {
  const totalSeconds = Math.max(0, Math.round(delayMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}秒`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分钟`;
}

function logWithShanghaiTime(message) {
  console.log(`[${formatShanghaiDateTime()}] ${message}`);
}

function summarizeMonitorLog(payload) {
  const slots = Array.isArray(payload.slots) ? payload.slots : [];
  const availableSlots = Array.isArray(payload.availableSlots) ? payload.availableSlots : [];
  const availabilityText = payload.hasAvailability ? "有号" : "无号";
  const latencyText = Number.isFinite(payload.lastQueryLatencyMs) ? `${payload.lastQueryLatencyMs}ms` : "-";
  const slotCampuses = [
    ...new Set(
      slots
        .map((slot) => slot.hospitalName || slot.areaName || "")
        .filter(Boolean)
    )
  ];
  const campusText = slotCampuses.length ? slotCampuses.join("/") : payload.campusName || "-";
  const summaryText = payload.lastResultSummary || "-";

  return `${payload.doctorName} | ${campusText} | ${payload.departmentName} | ${availabilityText} | 排班=${slots.length} | 可约=${availableSlots.length} | 延迟=${latencyText} | ${summaryText}`;
}

async function resolveHospitalAccessToken(monitor, sourceConfig) {
  const staticToken = process.env.HOSPITAL_ACCESS_TOKEN || "";
  const fetchTemplate = process.env.HOSPITAL_ACCESS_TOKEN_URL || "";
  if (!fetchTemplate) {
    return staticToken;
  }

  const now = Date.now();
  const variables = tokenVariablesForMonitor(monitor, sourceConfig);
  const url = replacePlaceholders(fetchTemplate, variables);
  const method = (process.env.HOSPITAL_ACCESS_TOKEN_METHOD || "POST").toUpperCase();
  const headers = replacePlaceholders(parseJsonEnv("HOSPITAL_ACCESS_TOKEN_HEADERS_JSON", {}), variables);
  const bodyTemplate = parseJsonEnv("HOSPITAL_ACCESS_TOKEN_BODY_JSON", null);
  const body = bodyTemplate === null ? null : replacePlaceholders(bodyTemplate, variables);
  const requestOptions = { method, headers };
  const cacheKey = hashValue({ url, method, headers, body });
  const cached = hospitalAccessTokenCache.get(cacheKey);
  if (cached && cached.token && cached.expiresAt > now + 15_000) {
    return cached.token;
  }

  if (body !== null && method !== "GET") {
    requestOptions.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      requestOptions.headers = {
        ...headers,
        "Content-Type": "application/json"
      };
    }
  }

  const response = await fetch(url, requestOptions);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : {};
  const fieldPath = process.env.HOSPITAL_ACCESS_TOKEN_RESPONSE_FIELD || "access_token";
  const token = getByPath(payload, fieldPath) || "";
  const ttlRaw = getByPath(
    payload,
    process.env.HOSPITAL_ACCESS_TOKEN_EXPIRES_FIELD || "expires_in"
  );
  const ttlSec = Number(ttlRaw || process.env.HOSPITAL_ACCESS_TOKEN_TTL_SECONDS || 3600);
  hospitalAccessTokenCache.set(cacheKey, {
    token: String(token),
    expiresAt: now + Math.max(30, ttlSec - 60) * 1000
  });
  return String(token);
}

async function getWechatApiAccessToken() {
  if (!appSecret) {
    return "";
  }

  const now = Date.now();
  if (wechatApiTokenCache.accessToken && wechatApiTokenCache.expiresAt > now + 60_000) {
    return wechatApiTokenCache.accessToken;
  }

  const params = new URLSearchParams({
    grant_type: "client_credential",
    appid: appId,
    secret: appSecret
  });
  const response = await fetch(`https://api.weixin.qq.com/cgi-bin/token?${params.toString()}`);
  const payload = await response.json();
  if (!payload.access_token) {
    return "";
  }

  const ttl = Number(payload.expires_in || 7200);
  wechatApiTokenCache = {
    accessToken: payload.access_token,
    expiresAt: now + Math.max(120, ttl - 300) * 1000
  };
  return payload.access_token;
}

function collectNotifyOpenids() {
  const merged = [...notifyOpenidsFromEnv, ...registeredNotifyOpenids];
  let unique = [...new Set(merged)];
  if (allowedOpenids.size > 0) {
    unique = unique.filter((openid) => allowedOpenids.has(openid));
  }
  return unique;
}

async function sendSubscribeMessage(openid, monitor, checkedAtIso) {
  const templateId = (process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID || "").split(",")[0].trim();
  if (!templateId) {
    return { ok: false, error: "missing_template_id" };
  }

  const accessToken = await getWechatApiAccessToken();
  if (!accessToken) {
    return { ok: false, error: "wechat_token_unavailable" };
  }

  const variables = {
    doctorName: monitor.doctorName,
    hospitalName: monitor.hospitalName,
    campusName: monitor.campusName,
    departmentName: monitor.departmentName,
    registrationType: monitor.registrationType,
    monitorId: monitor.id,
    checkedAt: checkedAtIso.slice(0, 16).replace("T", " "),
    availabilityTime: getSubscribeAvailabilityTime(monitor, checkedAtIso),
    alertTip: buildSubscribeAlertTip(monitor)
  };
  const defaultTemplate = {
    time1: { value: "{{availabilityTime}}" },
    short_thing2: { value: "{{doctorName}}" },
    thing3: { value: "{{alertTip}}" }
  };
  const template = parseJsonEnv("WECHAT_SUBSCRIBE_TEMPLATE_DATA_JSON", defaultTemplate);
  const data = normalizeSubscribeTemplateData(replacePlaceholders(template, variables));
  const url = `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      touser: openid,
      template_id: templateId,
      page: process.env.WECHAT_SUBSCRIBE_PAGE || "pages/index/index",
      miniprogram_state: process.env.WECHAT_SUBSCRIBE_MINIPROGRAM_STATE || "trial",
      lang: "zh_CN",
      data
    })
  });
  const payload = await response.json();
  return {
    ok: payload.errcode === 0,
    errcode: payload.errcode,
    errmsg: payload.errmsg
  };
}

function getSubscribeAvailabilityTime(monitor, fallbackIso) {
  if (monitor.availabilityTime) {
    return monitor.availabilityTime;
  }

  const slot = Array.isArray(monitor.availableSlots) ? monitor.availableSlots[0] : null;
  if (slot && slot.visitDate) {
    return formatSubscribeTimeValue(slot.visitDate, slot.durationCode, slot.durationName);
  }
  return formatSubscribeTimeValue(formatShanghaiDate(new Date(fallbackIso)), "", "");
}

function formatSubscribeTimeValue(visitDate, durationCode, durationName) {
  const match = String(visitDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return formatShanghaiDateTime().slice(0, 16);
  }

  const [, year, month, day] = match;
  const normalizedDuration = `${durationCode || ""} ${durationName || ""}`.toUpperCase();
  let time = "08:00";
  if (normalizedDuration.includes("PM") || normalizedDuration.includes("下午")) {
    time = "14:00";
  } else if (normalizedDuration.includes("NT") || normalizedDuration.includes("EVENING") || normalizedDuration.includes("夜")) {
    time = "18:00";
  }

  return `${Number(year)}年${Number(month)}月${Number(day)}日 ${time}`;
}

function buildSubscribeAlertTip(monitor) {
  if (monitor.alertTip) {
    return monitor.alertTip;
  }

  const slot = Array.isArray(monitor.availableSlots) ? monitor.availableSlots[0] : null;
  if (!slot) {
    return `${monitor.doctorName}有号，请速看。`;
  }

  const timeText = `${slot.visitDate || ""} ${slot.weekday || ""} ${slot.durationName || ""}`.trim();
  const priceText = slot.regPrice ? `，挂号费${slot.regPrice}元` : "";
  return `${monitor.doctorName}${timeText}有号${priceText}，请速看。`;
}

function getSlotNotificationKey(monitor, slot) {
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

function withNotificationKeys(monitor, monitorPayload) {
  const availableSlots = Array.isArray(monitorPayload.availableSlots) ? monitorPayload.availableSlots : [];
  return {
    ...monitorPayload,
    availableSlots: availableSlots.map((slot) => ({
      ...slot,
      notificationKey: slot.notificationKey || getSlotNotificationKey(monitor, slot)
    }))
  };
}

function getUnnotifiedAvailableSlots(monitor, monitorPayload) {
  const keyedPayload = withNotificationKeys(monitor, monitorPayload);
  return keyedPayload.availableSlots.filter((slot) => !notifiedSlotRecords.has(slot.notificationKey));
}

function markSlotsNotified(monitor, slots, reason) {
  const notifiedAt = new Date().toISOString();
  for (const slot of slots) {
    const key = slot.notificationKey || getSlotNotificationKey(monitor, slot);
    notifiedSlotRecords.set(key, {
      key,
      monitorId: monitor.id,
      doctorName: monitor.doctorName,
      campusName: monitor.campusName,
      scheduleId: slot.scheduleId || "",
      visitDate: slot.visitDate || "",
      durationName: slot.durationName || "",
      specCode: slot.specCode || "",
      specName: slot.specName || "",
      regTypeName: slot.regTypeName || "",
      notifiedAt,
      reason
    });
  }
  saveNotifiedSlotRecords();
}

async function notifyAvailability(monitor, monitorPayload, reason) {
  const unnotifiedSlots = getUnnotifiedAvailableSlots(monitor, monitorPayload);
  if (unnotifiedSlots.length === 0) {
    logWithShanghaiTime(`订阅消息跳过：${monitor.doctorName} ${monitor.campusName} reason=${reason} 可约号源已通知过`);
    return [{
      ok: true,
      skipped: true,
      reason: "already_notified"
    }];
  }

  const openids = collectNotifyOpenids();
  if (openids.length === 0) {
    logWithShanghaiTime(`订阅消息跳过：${monitor.doctorName} ${monitor.campusName} reason=${reason} notifyOpenids=0`);
    return [];
  }

  const checkedAt = monitorPayload.lastCheckedAt || new Date().toISOString();
  const monitorForMessage = {
    ...monitor,
    ...monitorPayload,
    availableSlots: unnotifiedSlots
  };
  const results = await Promise.all(
    openids.map(async (openid) => ({
      openid,
      ...(await sendSubscribeMessage(openid, monitorForMessage, checkedAt))
    }))
  );
  const okCount = results.filter((result) => result.ok).length;
  const failed = results
    .filter((result) => !result.ok)
    .map((result) => `${result.errcode || result.error || "unknown"}:${result.errmsg || ""}`)
    .join("; ");
  if (results.length > 0 && okCount === results.length) {
    markSlotsNotified(monitor, unnotifiedSlots, reason);
  }
  logWithShanghaiTime(`订阅消息发送：${monitor.doctorName} ${monitor.campusName} reason=${reason} slots=${unnotifiedSlots.length} ok=${okCount}/${results.length}${failed ? ` failed=${failed}` : ""}`);
  return results;
}

async function maybeNotifyAvailabilityEdge(monitor, monitorPayload) {
  if (!monitorPayload.enabled) {
    previousMonitorAvailability.set(monitor.id, monitorPayload.hasAvailability === true);
    return;
  }

  const curr = monitorPayload.hasAvailability === true;
  const prev = previousMonitorAvailability.get(monitor.id) === true;
  previousMonitorAvailability.set(monitor.id, curr);

  if (!curr || prev) {
    return;
  }

  const allowMock = process.env.NOTIFY_ON_MOCK_TRANSITION === "true";
  if (monitorPayload.sourceMode !== "real" && !allowMock) {
    return;
  }

  await notifyAvailability(monitor, monitorPayload, "availability_edge");
}

function getDoctorSourceConfig(monitorId) {
  const configs = parseJsonEnv("HOSPITAL_DOCTOR_SOURCE_CONFIG_JSON", {});
  if (configs[monitorId]) {
    return configs[monitorId];
  }

  const alias = legacyDoctorSourceConfigAliases[monitorId];
  if (!alias || !configs[alias.legacyId]) {
    return {};
  }

  const legacyConfig = configs[alias.legacyId];
  const { sources, doctorCodes, hospitalIds, ...baseConfig } = legacyConfig;

  if (Array.isArray(sources)) {
    const matchedSource = sources.find((source) => {
      return source && String(source.hospitalId || "") === alias.hospitalId;
    });
    if (matchedSource) {
      return {
        ...baseConfig,
        ...matchedSource,
        hospitalId: alias.hospitalId
      };
    }
  }

  if (Array.isArray(doctorCodes) && Array.isArray(hospitalIds)) {
    const index = hospitalIds.findIndex((hospitalId) => String(hospitalId) === alias.hospitalId);
    if (index !== -1 && doctorCodes[index]) {
      return {
        ...baseConfig,
        doctorCode: doctorCodes[index],
        hospitalId: alias.hospitalId
      };
    }
  }

  return {
    ...baseConfig,
    hospitalId: alias.hospitalId
  };
}

function normalizeDoctorSourceConfigs(monitorId) {
  const config = getDoctorSourceConfig(monitorId);
  const { sources, doctorCodes, hospitalIds, ...baseConfig } = config;

  if (Array.isArray(sources) && sources.length > 0) {
    return sources.map((source) => ({
      ...baseConfig,
      ...(source && typeof source === "object" ? source : {})
    }));
  }

  if (Array.isArray(doctorCodes) && doctorCodes.length > 0) {
    return doctorCodes.map((doctorCode, index) => ({
      ...baseConfig,
      doctorCode,
      hospitalId: Array.isArray(hospitalIds) ? hospitalIds[index] || baseConfig.hospitalId : baseConfig.hospitalId
    }));
  }

  return [baseConfig];
}

function getSourceLabel(sourceConfig, index) {
  const parts = [
    sourceConfig.label || `source-${index + 1}`,
    sourceConfig.hospitalId ? `hospitalId=${sourceConfig.hospitalId}` : "",
    sourceConfig.doctorCode ? `doctorCode=${sourceConfig.doctorCode}` : ""
  ].filter(Boolean);
  return parts.join(" ");
}

async function buildHospitalRequest(monitor, sourceConfig = getDoctorSourceConfig(monitor.id)) {
  const endpoint = process.env.HOSPITAL_AVAILABILITY_URL || "";
  if (!endpoint) {
    return {
      ok: false,
      error: "hospital_url_missing",
      message: "请在 server/.env 中配置 HOSPITAL_AVAILABILITY_URL"
    };
  }

  const accessToken = await resolveHospitalAccessToken(monitor, sourceConfig);
  const { startDate, endDate } = getMonitorDateRange();
  const variables = {
    monitorId: monitor.id,
    doctorName: monitor.doctorName,
    departmentName: monitor.departmentName,
    campusName: monitor.campusName,
    hospitalName: monitor.hospitalName,
    registrationType: monitor.registrationType,
    windowDays: process.env.MONITOR_WINDOW_DAYS || "14",
    startDate,
    endDate,
    accessToken,
    ...sourceConfig
  };

  const method = (process.env.HOSPITAL_AVAILABILITY_METHOD || "POST").toUpperCase();
  const headersTemplate = parseJsonEnv("HOSPITAL_AVAILABILITY_HEADERS_JSON", {});
  const bodyTemplate = parseJsonEnv("HOSPITAL_AVAILABILITY_BODY_JSON", null);
  const headers = replacePlaceholders(headersTemplate, variables);
  const body = bodyTemplate === null ? null : replacePlaceholders(bodyTemplate, variables);

  return {
    ok: true,
    request: {
      url: replacePlaceholders(endpoint, variables),
      method,
      headers,
      body
    }
  };
}

function tryParseJsonPayload(payload) {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  if (payload && typeof payload === "object") {
    return payload;
  }

  return null;
}

function inferAvailabilityStructured(payload) {
  const path = (process.env.HOSPITAL_AVAILABILITY_POSITIVE_JSONPATH || "").trim();
  if (!path) {
    return null;
  }

  const obj = tryParseJsonPayload(payload);
  if (!obj) {
    return null;
  }

  const value = getByPath(obj, path);
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (typeof value === "number") {
    return value > 0;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value && typeof value === "object") {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed === "0") {
      return false;
    }
    return trimmed.toLowerCase() !== "false";
  }

  return Boolean(value);
}

function inferAvailability(rawText) {
  const availableKeywords = (process.env.HOSPITAL_AVAILABLE_KEYWORDS || "有号,可预约,剩余")
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  const unavailableKeywords = (process.env.HOSPITAL_UNAVAILABLE_KEYWORDS || "无号,约满,停诊")
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);

  const hasAvailableKeyword = availableKeywords.some((keyword) => rawText.includes(keyword));
  const hasUnavailableKeyword = unavailableKeywords.some((keyword) => rawText.includes(keyword));

  if (hasAvailableKeyword && !hasUnavailableKeyword) {
    return true;
  }

  return false;
}

function parseTjhRegSources(payload, monitor, sourceConfig = getDoctorSourceConfig(monitor.id)) {
  const obj = tryParseJsonPayload(payload);
  if (!obj || !Array.isArray(obj.data)) {
    return null;
  }

  const slots = [];

  for (const hospitalGroup of obj.data) {
    const doctors = Array.isArray(hospitalGroup.list) ? hospitalGroup.list : [];
    for (const doctor of doctors) {
      const regSourceList = Array.isArray(doctor.regSourceList) ? doctor.regSourceList : [];
      for (const source of regSourceList) {
        if (!shouldIncludeTjhSlot(source, doctor, hospitalGroup, sourceConfig)) {
          continue;
        }

        const outpDate = Number(source.outpDate);
        const visitDate = Number.isFinite(outpDate) ? formatShanghaiDate(new Date(outpDate)) : "";
        const weekday = Number.isFinite(outpDate) ? formatShanghaiWeekday(outpDate) : source.weekday || "";
        const availableStatus = String(source.availableStatus ?? doctor.availableStatus ?? "");
        const available = availableStatus === "1";
        const availableStatusName = getTjhAvailableStatusName(availableStatus);

        slots.push({
          available,
          availableStatus,
          availableStatusName,
          scheduleId: source.scheduleId || "",
          doctorCode: source.doctorCode || doctor.doctorCode || "",
          doctorName: doctor.doctorName || "",
          hospitalId: hospitalGroup.hospitalId || "",
          hospitalName: hospitalGroup.hospitalName || source.areaName || doctor.areaName || "",
          areaCode: source.areaCode || doctor.areaCode || "",
          areaName: source.areaName || doctor.areaName || "",
          specCode: source.specCode || doctor.specCode || "",
          specName: source.specName || doctor.specName || "",
          deptCode: doctor.deptCode || "",
          deptName: doctor.deptName || "",
          visitDate,
          weekday,
          durationCode: source.durationCode || "",
          durationName: source.durationName || "",
          regTypeCode: source.regTypeCode || "",
          regTypeName: source.regTypeName || "",
          regPrice: source.regPrice || "",
          titleName: source.titleName || doctor.titleName || doctor.titleCode || ""
        });
      }
    }
  }

  const availableSlots = slots.filter((slot) => slot.available);
  return {
    hasAvailability: availableSlots.length > 0,
    slots,
    availableSlots
  };
}

function shouldIncludeTjhSlot(source, doctor, hospitalGroup, sourceConfig) {
  const expectedHospitalId = sourceConfig.hospitalId ? String(sourceConfig.hospitalId) : "";
  const expectedSpecName = sourceConfig.specName ? String(sourceConfig.specName) : "";
  const expectedSpecCode = sourceConfig.specCode ? String(sourceConfig.specCode) : "";
  const actualHospitalId = String(hospitalGroup.hospitalId || source.hospitalId || doctor.hospitalId || "");
  const actualSpecName = String(source.specName || doctor.specName || "");
  const actualSpecCode = String(source.specCode || doctor.specCode || "");

  if (expectedHospitalId && actualHospitalId !== expectedHospitalId) {
    return false;
  }

  if (expectedSpecCode && actualSpecCode !== expectedSpecCode) {
    return false;
  }

  if (!expectedSpecCode && expectedSpecName && actualSpecName !== expectedSpecName) {
    return false;
  }

  return true;
}

function getTjhAvailableStatusName(status) {
  const statusMap = {
    "1": "可约",
    "2": "约满",
    "3": "停诊",
    "4": "过期"
  };
  return statusMap[String(status)] || `未知状态${status}`;
}

function compareTjhSlots(left, right) {
  return [
    String(left.visitDate || "").localeCompare(String(right.visitDate || "")),
    String(left.durationCode || "").localeCompare(String(right.durationCode || "")),
    String(left.hospitalId || "").localeCompare(String(right.hospitalId || "")),
    String(left.scheduleId || "").localeCompare(String(right.scheduleId || ""))
  ].find((value) => value !== 0) || 0;
}

function summarizeHospitalPayload(payload, monitor, sourceConfig) {
  if (process.env.HOSPITAL_RESPONSE_FORMAT === "tjh_reg_sources") {
    const parsed = parseTjhRegSources(payload, monitor, sourceConfig);
    if (parsed) {
      const rawText = typeof payload === "string" ? payload : JSON.stringify(payload);
      const summary = {
        hasAvailability: parsed.hasAvailability,
        rawLength: rawText.length,
        slots: parsed.slots,
        availableSlots: parsed.availableSlots
      };

      if (process.env.DEBUG_RAW_HOSPITAL_RESPONSE === "true") {
        summary.rawPreview = redactSensitiveText(rawText).slice(0, 2000);
      }

      return summary;
    }
  }

  const structured = inferAvailabilityStructured(payload);
  const rawText = typeof payload === "string" ? payload : JSON.stringify(payload);
  const hasAvailability = structured !== null ? structured : inferAvailability(rawText);
  const summary = {
    hasAvailability,
    rawLength: rawText.length
  };

  if (process.env.DEBUG_RAW_HOSPITAL_RESPONSE === "true") {
    summary.rawPreview = redactSensitiveText(rawText).slice(0, 2000);
  }

  return summary;
}

async function queryHospitalAvailabilitySource(monitor, sourceConfig) {
  const built = await buildHospitalRequest(monitor, sourceConfig);
  if (!built.ok) {
    return built;
  }

  const { url, method, headers, body } = built.request;
  const requestOptions = {
    method,
    headers
  };

  if (body !== null && method !== "GET") {
    requestOptions.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      requestOptions.headers = {
        ...headers,
        "Content-Type": "application/json"
      };
    }
  }

  const startedAt = Date.now();
  const response = await fetch(url, requestOptions);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : await response.text();
  const summary = summarizeHospitalPayload(payload, monitor, sourceConfig);

  return {
    ok: response.ok,
    status: response.status,
    latencyMs: Date.now() - startedAt,
    request: {
      url: redactUrl(url),
      method
    },
    ...summary
  };
}

function mergeHospitalAvailabilityResults(results) {
  const successfulResults = results.filter((result) => result.ok);
  if (successfulResults.length === 0) {
    return results[0] || {
      ok: false,
      error: "hospital_query_failed",
      message: "真实接口查询失败"
    };
  }

  const slots = successfulResults
    .flatMap((result) => Array.isArray(result.slots) ? result.slots : [])
    .sort(compareTjhSlots);
  const availableSlots = slots.filter((slot) => slot.available);
  const latencyMs = results.reduce((max, result) => Math.max(max, Number(result.latencyMs) || 0), 0);

  return {
    ...successfulResults[0],
    ok: true,
    latencyMs,
    hasAvailability: availableSlots.length > 0,
    slots,
    availableSlots,
    sourceResults: results.map((result) => ({
      ok: result.ok,
      status: result.status,
      error: result.error,
      message: result.message,
      rawLength: result.rawLength,
      latencyMs: result.latencyMs,
      slotsCount: Array.isArray(result.slots) ? result.slots.length : 0,
      availableSlotsCount: Array.isArray(result.availableSlots) ? result.availableSlots.length : 0
    }))
  };
}

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

async function buildMonitorPayload(monitor) {
  if (!hospitalApiEnabled) {
    return {
      ...monitor,
      sourceMode: "mock"
    };
  }

  try {
    const result = await queryHospitalAvailability(monitor);
    if (!result.ok) {
      return {
        ...monitor,
        sourceMode: "real",
        hasAvailability: false,
        lastResultSummary: result.message || `真实接口查询失败：${result.status || result.error}`,
        lastError: result.error || result.status
      };
    }

    const firstAvailableSlot = Array.isArray(result.availableSlots) ? result.availableSlots[0] : null;
    const firstSlot = Array.isArray(result.slots) ? result.slots[0] : null;
    const slotSummary = firstAvailableSlot || firstSlot;
    const readableSlot = slotSummary
      ? `${slotSummary.visitDate} ${slotSummary.weekday} ${slotSummary.durationName} ${slotSummary.regTypeName || ""} ${slotSummary.regPrice ? `¥${slotSummary.regPrice}` : ""} ${slotSummary.availableStatusName || ""}`.trim()
      : "";

    return {
      ...monitor,
      sourceMode: "real",
      hasAvailability: result.hasAvailability,
      lastResultSummary: result.hasAvailability
        ? `发现可约：${readableSlot}`
        : readableSlot
          ? `暂不可约：${readableSlot}`
          : "真实接口暂未发现号源排班",
      lastQueryLatencyMs: result.latencyMs,
      slots: result.slots || [],
      availableSlots: result.availableSlots || []
    };
  } catch (error) {
    return {
      ...monitor,
      sourceMode: "real",
      hasAvailability: false,
      lastResultSummary: `真实接口查询异常：${error.message}`,
      lastError: error.message
    };
  }
}

async function runMonitorTick({ notify = true, trigger = "manual" } = {}) {
  const checkedAt = new Date().toISOString();
  const { startDate, endDate } = getMonitorDateRange();
  logWithShanghaiTime(`监控查询开始：trigger=${trigger} notify=${notify} window=${startDate}..${endDate}`);
  const monitorPayloads = await Promise.all(monitors.map(buildMonitorPayload));

  for (let index = 0; index < monitors.length; index += 1) {
    const monitor = monitors[index];
    const payload = {
      ...monitorPayloads[index],
      lastCheckedAt: checkedAt
    };
    monitorState.set(monitor.id, payload);

    if (notify) {
      await maybeNotifyAvailabilityEdge(monitor, payload);
    } else {
      previousMonitorAvailability.set(monitor.id, payload.hasAvailability === true);
    }

    logWithShanghaiTime(`监控查询结果：${summarizeMonitorLog(payload)}`);
  }

  logWithShanghaiTime(`监控查询结束：trigger=${trigger} count=${monitorPayloads.length}`);
  return [...monitorState.values()];
}

function getMonitorStateList() {
  return monitors.map((monitor) => monitorState.get(monitor.id) || monitor);
}

async function runScheduledMonitorTick() {
  if (monitorInFlight) {
    logWithShanghaiTime("自动轮询跳过：上一轮查询仍在执行");
    return;
  }

  monitorInFlight = true;
  try {
    await runMonitorTick({ notify: true, trigger: "auto" });
  } catch (error) {
    console.error(`[${formatShanghaiDateTime()}] 自动轮询失败：${error.message}`);
  } finally {
    monitorInFlight = false;
  }
}

function scheduleNextMonitorTick() {
  const delay = nextMonitorDelayMs();
  const nextRunAt = new Date(Date.now() + delay);
  const windowName = isPriorityMonitorWindow() ? "重点时段" : "普通时段";
  logWithShanghaiTime(`下次自动轮询：${formatShanghaiDateTime(nextRunAt)}（${formatDelay(delay)}后，${windowName}）`);
  monitorTimer = setTimeout(async () => {
    await runScheduledMonitorTick();
    scheduleNextMonitorTick();
  }, delay);
}

function startMonitorScheduler() {
  if (process.env.MONITOR_AUTO_POLL_ENABLED !== "true") {
    logWithShanghaiTime("自动轮询未开启：MONITOR_AUTO_POLL_ENABLED != true");
    return;
  }

  if (monitorTimer) {
    clearTimeout(monitorTimer);
  }

  logWithShanghaiTime("自动轮询已开启：重点时段随机 1-5 秒，其他时段随机 1-10 分钟");
  runScheduledMonitorTick().finally(() => {
    scheduleNextMonitorTick();
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        request.destroy();
        reject(new Error("request_body_too_large"));
      }
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid_json_body"));
      }
    });
    request.on("error", reject);
  });
}

async function exchangeCodeForOpenid(code) {
  if (!appSecret) {
    return {
      ok: false,
      statusCode: 500,
      payload: {
        error: "wechat_app_secret_missing",
        message: "请在 server/.env 中配置 WECHAT_APP_SECRET"
      }
    };
  }

  const params = new URLSearchParams({
    appid: appId,
    secret: appSecret,
    js_code: code,
    grant_type: "authorization_code"
  });
  const url = `https://api.weixin.qq.com/sns/jscode2session?${params.toString()}`;
  const response = await fetch(url);
  const payload = await response.json();

  if (!response.ok || payload.errcode) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "wechat_code2session_failed",
        errcode: payload.errcode,
        errmsg: payload.errmsg || "微信登录凭证校验失败"
      }
    };
  }

  return {
    ok: true,
    statusCode: 200,
    payload: {
      openid: payload.openid,
      unionid: payload.unionid || "",
      isWhitelisted: allowedOpenids.size === 0 ? false : allowedOpenids.has(payload.openid)
    }
  };
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      service: "号来了后端",
      appId,
      hasWechatSecret: Boolean(appSecret),
      hospitalApiEnabled,
      hasSubscribeTemplate: Boolean((process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID || "").trim()),
      notifyOpenidCount: collectNotifyOpenids().length,
      notifiedSlotCount: notifiedSlotRecords.size,
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    const templateIdRaw = process.env.WECHAT_SUBSCRIBE_TEMPLATE_ID || "";
    const subscribeTemplateIds = templateIdRaw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    sendJson(response, 200, {
      appId,
      subscribeTemplateIds,
      hospitalApiEnabled
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/wechat-login") {
    try {
      const body = await readJsonBody(request);
      if (!body.code || typeof body.code !== "string") {
        sendJson(response, 400, {
          error: "missing_code",
          message: "请传入 wx.login 获取到的 code"
        });
        return;
      }

      const result = await exchangeCodeForOpenid(body.code);
      sendJson(response, result.statusCode, result.payload);
    } catch (error) {
      sendJson(response, 500, {
        error: "wechat_login_failed",
        message: error.message
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/subscribe/register") {
    try {
      const body = await readJsonBody(request);
      if (!body.code || typeof body.code !== "string") {
        sendJson(response, 400, {
          error: "missing_code",
          message: "请传入 wx.login 获取的 code"
        });
        return;
      }

      const result = await exchangeCodeForOpenid(body.code);
      if (!result.ok) {
        sendJson(response, result.statusCode, result.payload);
        return;
      }

      const openid = result.payload.openid;
      if (allowedOpenids.size > 0 && !allowedOpenids.has(openid)) {
        sendJson(response, 403, {
          error: "openid_not_allowlisted",
          message: "该账号不在 ALLOWED_OPENIDS 白名单中，无法接收提醒"
        });
        return;
      }

      registeredNotifyOpenids.add(openid);
      saveRegisteredNotifyOpenids();
      sendJson(response, 200, {
        ok: true,
        openid,
        notifyOpenidCount: collectNotifyOpenids().length
      });
    } catch (error) {
      sendJson(response, 500, {
        error: "subscribe_register_failed",
        message: error.message
      });
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/subscribe/status") {
    try {
      const body = await readJsonBody(request);
      if (!body.code || typeof body.code !== "string") {
        sendJson(response, 400, {
          error: "missing_code",
          message: "请传入 wx.login 获取的 code"
        });
        return;
      }

      const result = await exchangeCodeForOpenid(body.code);
      if (!result.ok) {
        sendJson(response, result.statusCode, result.payload);
        return;
      }

      const openid = result.payload.openid;
      const registered = collectNotifyOpenids().includes(openid);
      sendJson(response, 200, {
        ok: true,
        registered,
        notifyOpenidCount: collectNotifyOpenids().length
      });
    } catch (error) {
      sendJson(response, 500, {
        error: "subscribe_status_failed",
        message: error.message
      });
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/monitors") {
    sendJson(response, 200, {
      windowDays: Number(process.env.MONITOR_WINDOW_DAYS || 14),
      priorityWindow: "16:50-17:10",
      sharedHospitalAccount: true,
      monitors: getMonitorStateList()
    });
    return;
  }

  if (
    (request.method === "POST" || request.method === "GET") &&
    url.pathname === "/api/monitor/tick"
  ) {
    const notify = url.searchParams.get("notify") !== "false";
    const monitorPayloads = await runMonitorTick({ notify, trigger: "api" });
    sendJson(response, 200, {
      ok: true,
      notified: notify,
      checkedAt: new Date().toISOString(),
      monitors: monitorPayloads
    });
    return;
  }

  if (
    (request.method === "POST" || request.method === "GET") &&
    url.pathname === "/api/notify/test"
  ) {
    const openids = collectNotifyOpenids();
    if (openids.length === 0) {
      sendJson(response, 400, {
        ok: false,
        error: "no_notify_openids",
        message: "还没有可通知的 openid。请先在小程序医生详情页点击“订阅有号提醒”并接受授权。"
      });
      return;
    }

    const now = new Date().toISOString();
    const monitorId = url.searchParams.get("id") || monitors[0].id;
    const baseMonitor = monitorState.get(monitorId) || monitors.find((item) => item.id === monitorId) || monitors[0];
    const testMonitor = {
      ...baseMonitor,
      availabilityTime: url.searchParams.get("time") || now.slice(0, 16).replace("T", " "),
      alertTip:
        url.searchParams.get("message") ||
        `${baseMonitor.doctorName}提醒测试成功`
    };
    const results = await Promise.all(
      openids.map(async (openid) => ({
        openid,
        ...(await sendSubscribeMessage(openid, testMonitor, now))
      }))
    );

    sendJson(response, 200, {
      ok: results.every((item) => item.ok),
      recipientCount: openids.length,
      results
    });
    return;
  }

  if (
    (request.method === "POST" || request.method === "GET") &&
    url.pathname === "/api/notify/current"
  ) {
    const monitorId = url.searchParams.get("id") || "";
    const candidates = getMonitorStateList().filter((monitor) => {
      return monitor.hasAvailability === true && (!monitorId || monitor.id === monitorId);
    });

    if (candidates.length === 0) {
      sendJson(response, 404, {
        ok: false,
        error: "no_current_availability",
        message: monitorId ? "该监控当前没有可约号源" : "当前没有可约号源"
      });
      return;
    }

    const results = [];
    for (const payload of candidates) {
      const monitor = monitors.find((item) => item.id === payload.id) || payload;
      results.push({
        monitorId: payload.id,
        doctorName: payload.doctorName,
        campusName: payload.campusName,
        results: await notifyAvailability(monitor, payload, "manual_current")
      });
    }

    sendJson(response, 200, {
      ok: results.every((item) => item.results.every((result) => result.ok)),
      notifiedMonitorCount: results.length,
      results
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/notify/history") {
    sendJson(response, 200, {
      count: notifiedSlotRecords.size,
      records: [...notifiedSlotRecords.values()]
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/hospital/debug-availability") {
    const id = url.searchParams.get("id") || monitors[0].id;
    const monitor = monitors.find((item) => item.id === id);
    if (!monitor) {
      sendJson(response, 404, {
        error: "monitor_not_found"
      });
      return;
    }

    try {
      const result = await queryHospitalAvailability(monitor);
      sendJson(response, result.ok ? 200 : 502, {
        monitor: {
          id: monitor.id,
          doctorName: monitor.doctorName,
          departmentName: monitor.departmentName,
          campusName: monitor.campusName
        },
        ...result
      });
    } catch (error) {
      sendJson(response, 500, {
        error: "hospital_debug_failed",
        message: error.message
      });
    }
    return;
  }

  sendJson(response, 404, {
    error: "not_found"
  });
}

const server = http.createServer(handleRequest);

server.listen(port, host, () => {
  logWithShanghaiTime(`号来了后端已启动：http://${host}:${port}`);
  startMonitorScheduler();
});
