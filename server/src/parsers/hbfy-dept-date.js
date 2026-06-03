// 接口对所有情况都返回 HTTP 200，靠 rc/msg 区分：
//   rc=1            → 正常（即便当天全约满，doclist 仍非空）
//   rc=-1 获取医生异常 → 会话失效（未登录/JSESSIONID 过期）
//   rc=-1 …为空      → 该日尚无排班，正常的空结果
//   其它 rc!=1       → 未知，按空处理但记日志观察
// 容忍只粘贴了 session id 的情况：无 "=" 时自动补 JSESSIONID= 前缀。
export function normalizeHbfyCookie(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  return value.includes("=") ? value : `JSESSIONID=${value}`;
}

export function classifyHbfyResponse(payload) {
  if (payload?.rc === 1) return "ok";
  const msg = String(payload?.msg || "");
  if (msg.includes("获取医生异常")) return "session_invalid";
  if (msg.includes("为空")) return "empty";
  return "unknown";
}

export function parseHbfyDeptDate(payload, options) {
  const { monitorId, outpDate, filter = {}, onUnknownStatus } = options;
  // 白名单：只有这些 status 视为可约。默认仅 "1"（实测 2/7=约满、3=停诊）。
  // 未知 status 一律按"不可约"处理，避免把停诊/约满误报成有号刷屏。
  const availableStatuses = new Set((filter.availableStatuses || ["1"]).map(String));

  const slots = [];
  const doctors = Array.isArray(payload?.doclist) ? payload.doclist : [];

  for (const doctor of doctors) {
    const ext = doctor.scheduleExtInfo || {};
    const dateValue = String(ext.outpDate || outpDate || "");

    if (ext.morning && typeof ext.morning === "object") {
      slots.push(toHbfySlot(doctor, ext.morning, "上午", "AM", dateValue, availableStatuses, monitorId, onUnknownStatus));
    }
    if (ext.afternoon && typeof ext.afternoon === "object") {
      slots.push(toHbfySlot(doctor, ext.afternoon, "下午", "PM", dateValue, availableStatuses, monitorId, onUnknownStatus));
    }
  }

  const availableSlots = slots.filter((slot) => slot.available);
  return {
    hasAvailability: availableSlots.length > 0,
    slots,
    availableSlots
  };
}

function toHbfySlot(doctor, period, durationName, durationCode, visitDate, availableStatuses, monitorId, onUnknownStatus) {
  const status = String(period.status || "");
  const isAvailable = availableStatuses.has(status);
  let availableStatusName = "未知";
  if (status === "1") availableStatusName = "可约";
  else if (status === "2" || status === "7") availableStatusName = "约满";
  else if (status === "3") availableStatusName = "停诊";
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
