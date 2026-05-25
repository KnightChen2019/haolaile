export function parseTjhappV2(payload, options) {
  const { monitorId, filter = {} } = options;
  const allowedHospitals = new Set((filter.hospitaldm || []).map(String));
  const allowedDepts = new Set((filter.deptCode || []).map(String));
  const allowedStatuses = new Set((filter.yystatus || ["可约"]).map(String));

  const slots = [];
  const groups = Array.isArray(payload?.datalistbyyq) ? payload.datalistbyyq : [];

  for (const group of groups) {
    const hospitaldm = String(group.hospitaldm || "");
    if (allowedHospitals.size > 0 && !allowedHospitals.has(hospitaldm)) {
      continue;
    }
    const schedules = Array.isArray(group.schedule) ? group.schedule : [];
    for (const schedule of schedules) {
      const deptCode = String(schedule.deptCode || "");
      if (allowedDepts.size > 0 && !allowedDepts.has(deptCode)) {
        continue;
      }
      const yystatus = String(schedule.yystatus || "");
      const isAvailable = allowedStatuses.has(yystatus);
      const slot = toTjhappSlot(schedule, group, isAvailable, monitorId);
      slots.push(slot);
    }
  }

  const availableSlots = slots.filter((slot) => slot.available);
  return {
    hasAvailability: availableSlots.length > 0,
    slots,
    availableSlots
  };
}

function toTjhappSlot(schedule, group, isAvailable, monitorId) {
  const visitDate = String(schedule.clinicDate || "");
  const durationName = String(schedule.clinicDuration || "");
  const deptCode = String(schedule.deptCode || "");
  const schedulecode = String(schedule.schedulecode || "");
  const hospitaldm = String(group.hospitaldm || "");

  return {
    available: isAvailable,
    availableStatus: String(schedule.yystatus || ""),
    availableStatusName: String(schedule.yystatus || ""),
    scheduleId: schedulecode,
    doctorCode: String(schedule.doctorCode || ""),
    doctorName: "",
    hospitalId: hospitaldm,
    hospitalName: String(group.hospitalmc || ""),
    deptCode,
    deptName: String(schedule.deptName || ""),
    departmentName: String(schedule.deptName || ""),
    visitDate,
    weekday: weekdayFromIsoDate(visitDate),
    durationCode: durationName === "上午" ? "AM" : durationName === "下午" ? "PM" : "",
    durationName,
    regTypeCode: String(schedule.scheduleType || ""),
    regTypeName: String(schedule.ghlx || ""),
    regPrice: schedule.sumFee !== undefined ? String(schedule.sumFee) : "",
    specCode: deptCode,
    specName: String(schedule.deptName || ""),
    notificationKey: `${monitorId}:${hospitaldm}:${visitDate}:${durationName}:${deptCode}:${schedulecode}`
  };
}

function weekdayFromIsoDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate || "");
  if (!match) return "";
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(date);
}
