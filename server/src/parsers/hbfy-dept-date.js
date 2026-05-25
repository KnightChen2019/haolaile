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
