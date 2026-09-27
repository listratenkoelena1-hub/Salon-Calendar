"use strict";

const crypto = require("node:crypto");

const LOCAL_START_MINUTES = 8 * 60;
const SLOT_MINUTES = 15;
const DASH_OPEN_MINUTES = 10 * 60;
const DASH_CLOSE_MINUTES = 20 * 60;
const DASH_REQUEST_TYPE = "dash_booking_request";
const DASH_SOURCE = "dash_booking";
const DASH_BLOCK_PREFIX = "Rose Calendar";
const DASH_ACTOR_LABEL = "DashBooking";

// These IDs were read from the visible Staff selector in the Dash partner UI.
// Aliases intentionally include the spellings currently used by the salon
// calendar so that a renamed display label does not silently block syncing.
const DASH_STAFF_DIRECTORY = Object.freeze([
  {
    dashName: "Luba",
    dashStaffId: "6632ba1a19eb6077e4491c40",
    aliases: ["luba", "liuba", "lyuba", "люба"]
  },
  {
    dashName: "Olha",
    dashStaffId: "6632c6df8a4abe92e7c4be81",
    aliases: ["olha", "olga", "ольга"]
  },
  {
    dashName: "Olena",
    dashStaffId: "677f109c3bbb234dc00035de",
    aliases: ["olena", "elena", "алена", "елена", "олена"]
  },
  {
    dashName: "Iryna",
    dashStaffId: "6632ba168a4abe92e7c0b18a",
    aliases: ["iryna", "irina", "ирина"]
  },
  {
    dashName: "Inna",
    dashStaffId: "6632c7418a4abe92e7c4d780",
    aliases: ["inna", "инна"]
  },
  {
    dashName: "Natalia",
    dashStaffId: "6632ccb38a4abe92e7c6504b",
    aliases: ["natalia", "nataliya", "natalya", "natasha", "наталия", "наталья", "наташа"]
  },
  {
    dashName: "Cindy",
    dashStaffId: "6632cc9c8a4abe92e7c64be5",
    aliases: ["cindy", "sindy", "синди"]
  },
  {
    dashName: "Lan",
    dashStaffId: "6632ba1e19eb6077e4491df1",
    aliases: ["lan", "лан"]
  },
  {
    dashName: "Anystaff Is Okay :)",
    dashStaffId: "6632ccde4900072caa93ed06",
    aliases: ["anyone", "any staff", "anystaff", "anystaff i o", "anystaff is okay"]
  },
  {
    dashName: "Tanya",
    dashStaffId: "6ab3f3488ecf50d467bc87d3",
    aliases: ["tanya", "tatiana", "tatyana", "таня", "татьяна"]
  }
]);

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-CA")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStaffName(value) {
  return normalizeText(value);
}

function getDirectoryEntryByDashName(value) {
  const normalized = normalizeStaffName(value);
  return DASH_STAFF_DIRECTORY.find(entry => (
    normalizeStaffName(entry.dashName) === normalized ||
    entry.aliases.some(alias => normalizeStaffName(alias) === normalized)
  )) || null;
}

function getExplicitMapping(localStaff, overrides = {}) {
  const id = String(localStaff?.id || "").trim();
  const candidate = (id && overrides[id]) || null;
  if (!candidate || candidate.enabled === false) return null;
  const dashStaffId = String(candidate.dashStaffId || "").trim();
  const dashName = String(candidate.dashName || "").trim();
  if (!dashStaffId || !dashName) return null;
  return { dashStaffId, dashName, source: "override" };
}

function resolveDashStaff(localStaff, overrides = {}) {
  if (!localStaff) return { ok: false, reason: "missing-local-staff" };
  const explicit = getExplicitMapping(localStaff, overrides);
  if (explicit) return { ok: true, ...explicit };

  const localId = normalizeStaffName(localStaff.id);
  const localName = normalizeStaffName(localStaff.name || localStaff.displayName);
  const entry = DASH_STAFF_DIRECTORY.find(item => item.aliases.some(alias => {
    const normalizedAlias = normalizeStaffName(alias);
    return normalizedAlias === localId || normalizedAlias === localName;
  }));

  if (!entry) {
    return {
      ok: false,
      reason: "unmapped-staff",
      localStaffId: String(localStaff.id || ""),
      localStaffName: String(localStaff.name || localStaff.displayName || "")
    };
  }

  return {
    ok: true,
    dashStaffId: entry.dashStaffId,
    dashName: entry.dashName,
    source: "directory"
  };
}

function resolveLocalStaffForDashName(staffRecords, dashName, overrides = {}) {
  const records = Array.isArray(staffRecords) ? staffRecords : [];
  const wanted = getDirectoryEntryByDashName(dashName);
  const normalizedDashName = normalizeStaffName(dashName);

  const explicit = records.find(record => {
    const mapping = getExplicitMapping(record, overrides);
    return mapping && normalizeStaffName(mapping.dashName) === normalizedDashName;
  });
  if (explicit) return explicit;

  if (!wanted) return null;
  return records.find(record => {
    const values = [record.id, record.name, record.displayName]
      .map(normalizeStaffName)
      .filter(Boolean);
    return wanted.aliases.some(alias => values.includes(normalizeStaffName(alias)));
  }) || null;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function slotToMinutes(slot) {
  const value = Number(slot);
  if (!Number.isInteger(value)) return null;
  return LOCAL_START_MINUTES + value * SLOT_MINUTES;
}

function minutesToTime(minutes) {
  const value = Number(minutes);
  if (!Number.isInteger(value) || value < 0 || value >= 24 * 60) return "";
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function timeToMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = String(match[3] || "").toLowerCase();
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (hours === 12) hours = 0;
    if (meridiem === "pm") hours += 12;
  } else if (hours > 23) {
    return null;
  }
  return hours * 60 + minutes;
}

function getCanonicalBlockInterval(block) {
  if (!block || !isIsoDate(block.date)) return null;
  const hasStartMinutes = block.startMinutes !== null && block.startMinutes !== undefined &&
    Number.isInteger(Number(block.startMinutes));
  const hasDurationMinutes = block.durationMinutes !== null && block.durationMinutes !== undefined &&
    Number.isInteger(Number(block.durationMinutes));
  const hasEndMinutes = block.endMinutes !== null && block.endMinutes !== undefined &&
    Number.isInteger(Number(block.endMinutes));
  const startMinutes = hasStartMinutes
    ? Number(block.startMinutes)
    : timeToMinutes(block.start);
  const explicitDuration = Number(block.durationMinutes);
  const endMinutes = hasEndMinutes
    ? Number(block.endMinutes)
    : timeToMinutes(block.end);
  const durationMinutes = hasDurationMinutes && explicitDuration > 0
    ? explicitDuration
    : Number.isInteger(endMinutes) && Number.isInteger(startMinutes)
      ? endMinutes - startMinutes
      : null;
  if (
    !Number.isInteger(startMinutes) || !Number.isInteger(durationMinutes) ||
    durationMinutes < 1 || startMinutes + durationMinutes > 24 * 60
  ) return null;
  const owner = String(block.dashStaffId || "").trim() ||
    normalizeStaffName(block.dashStaffName || block.staffName);
  if (!owner) return null;
  return {
    date: String(block.date),
    owner,
    startMinutes,
    durationMinutes,
    endMinutes: startMinutes + durationMinutes
  };
}

function buildCanonicalBlockKey(block) {
  const interval = getCanonicalBlockInterval(block);
  if (!interval) return "";
  return [
    interval.date,
    interval.owner,
    interval.startMinutes,
    interval.durationMinutes
  ].join("|");
}

function minutesToSlot(minutes) {
  const value = Number(minutes);
  if (!Number.isInteger(value)) return null;
  const offset = value - LOCAL_START_MINUTES;
  if (offset % SLOT_MINUTES !== 0) return null;
  return offset / SLOT_MINUTES;
}

function clipMinutesToDashHours(startMinutes, endMinutes) {
  const start = Math.max(Number(startMinutes), DASH_OPEN_MINUTES);
  const end = Math.min(Number(endMinutes), DASH_CLOSE_MINUTES);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { startMinutes: start, endMinutes: end };
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function buildBlockDescription(sourceType, sourceId) {
  const type = sourceType === "off_work" ? "off" : "appt";
  return `${DASH_BLOCK_PREFIX} | ${type}:${String(sourceId || "").trim()}`;
}

function buildBlockFingerprint(block) {
  if (!block) return "";
  return stableHash([
    block.sourceType,
    block.sourceId,
    block.date,
    block.start,
    block.end,
    block.dashStaffId,
    block.description
  ].join("|"));
}

function makeBlockResult({ sourceType, sourceId, date, startMinutes, endMinutes, mapping }) {
  const durationMinutes = Number(endMinutes) - Number(startMinutes);
  const block = {
    sourceType,
    sourceId: String(sourceId || ""),
    date,
    start: minutesToTime(startMinutes),
    end: minutesToTime(endMinutes),
    dashStaffId: mapping.dashStaffId,
    dashStaffName: mapping.dashName,
    description: buildBlockDescription(sourceType, sourceId),
    startMinutes,
    endMinutes,
    durationMinutes
  };
  return {
    ok: true,
    block: {
      ...block,
      canonicalKey: buildCanonicalBlockKey(block),
      fingerprint: buildBlockFingerprint(block)
    }
  };
}

function isPendingInternalOnlineRequest(appointment) {
  return appointment?.type === "online_booking_request" &&
    (appointment.status || "request") === "request";
}

function isDashOriginAppointment(appointment) {
  return appointment?.source === DASH_SOURCE ||
    appointment?.type === DASH_REQUEST_TYPE ||
    Boolean(appointment?.dashBookingId || appointment?.dashOriginBookingId);
}

function appointmentToDashBlock(appointment, localStaff, overrides = {}) {
  if (!appointment) return { ok: false, reason: "missing-appointment" };
  if (appointment.canceled === true || appointment.noShow === true) {
    return { ok: false, reason: "inactive-appointment" };
  }
  if (isPendingInternalOnlineRequest(appointment)) {
    return { ok: false, reason: "pending-online-request" };
  }
  if (isDashOriginAppointment(appointment)) {
    return { ok: false, reason: "dash-origin" };
  }
  if (!isIsoDate(appointment.date)) return { ok: false, reason: "invalid-date" };
  const startSlot = Number(appointment.start);
  const duration = Number(appointment.duration);
  if (!Number.isInteger(startSlot) || startSlot < 0) {
    return { ok: false, reason: "unspecified-start" };
  }
  if (!Number.isInteger(duration) || duration < 1) {
    return { ok: false, reason: "invalid-duration" };
  }
  const mapping = resolveDashStaff(localStaff, overrides);
  if (!mapping.ok) return mapping;
  const startMinutes = slotToMinutes(startSlot);
  const endMinutes = startMinutes + duration * SLOT_MINUTES;
  const clipped = clipMinutesToDashHours(startMinutes, endMinutes);
  if (!clipped) return { ok: false, reason: "outside-dash-hours" };
  return makeBlockResult({
    sourceType: "appointment",
    sourceId: appointment.id,
    date: appointment.date,
    ...clipped,
    mapping
  });
}

function offWorkToDashBlock(offWork, localStaff, overrides = {}) {
  if (!offWork) return { ok: false, reason: "missing-off-work" };
  if (offWork.weeklyException === true || offWork.enabled === false) {
    return { ok: false, reason: "inactive-off-work" };
  }
  if (!isIsoDate(offWork.date)) return { ok: false, reason: "invalid-date" };
  const mapping = resolveDashStaff(localStaff, overrides);
  if (!mapping.ok) return mapping;

  const allDay = offWork.allDay === true;
  const startSlot = allDay ? minutesToSlot(DASH_OPEN_MINUTES) : Number(offWork.start);
  const endSlot = allDay ? minutesToSlot(DASH_CLOSE_MINUTES) : Number(offWork.end);
  if (!Number.isInteger(startSlot) || !Number.isInteger(endSlot) || endSlot <= startSlot) {
    return { ok: false, reason: "invalid-off-work-range" };
  }
  const clipped = clipMinutesToDashHours(slotToMinutes(startSlot), slotToMinutes(endSlot));
  if (!clipped) return { ok: false, reason: "outside-dash-hours" };
  return makeBlockResult({
    sourceType: "off_work",
    sourceId: offWork.id,
    date: offWork.date,
    ...clipped,
    mapping
  });
}

function buildQueueId(sourceType, sourceId) {
  const type = sourceType === "off_work" ? "off" : "appt";
  return `${type}__${String(sourceId || "").replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function planQueueOperation({ desiredResult, existingLink }) {
  if (desiredResult?.ok) {
    if (existingLink?.fingerprint === desiredResult.block.fingerprint) {
      return { action: "noop", reason: "already-synced" };
    }
    return { action: "upsert", desired: desiredResult.block };
  }
  if (existingLink?.dashBlockId || existingLink?.editUrl) {
    return { action: "delete", reason: desiredResult?.reason || "source-removed" };
  }
  return { action: "noop", reason: desiredResult?.reason || "not-syncable" };
}

function parseDashNotification({ title, description, observedLabel = "" } = {}) {
  const cleanTitle = String(title || "").trim();
  const cleanDescription = String(description || "").replace(/\s+/g, " ").trim();
  const normalizedTitle = normalizeText(cleanTitle);
  let kind = "";
  let match = null;

  if (normalizedTitle === "new dash booking appointment") {
    kind = "created";
    match = cleanDescription.match(/^(.*?)\s+has booked an appointment[^\d]*(\d{4}-\d{2}-\d{2})(?:\s+at\s+(\d{1,2}:\d{2}))?/i);
  } else if (normalizedTitle === "appointment canceled" || normalizedTitle === "appointment cancelled") {
    kind = "canceled";
    match = cleanDescription.match(/^(.*?)\s+has cancel(?:ed|led)[^\d]*(\d{4}-\d{2}-\d{2})(?:\s+at\s+(\d{1,2}:\d{2}))?/i);
  } else if (normalizedTitle === "appointment rescheduled") {
    kind = "rescheduled";
    match = cleanDescription.match(/^(.*?)\s+has reschedule(?:d)?[^\d]*(\d{4}-\d{2}-\d{2})(?:\s+at\s+(\d{1,2}:\d{2}))?/i);
  }
  if (!kind || !match) return null;
  const notification = {
    kind,
    client: match[1].trim(),
    date: match[2],
    time: match[3] ? match[3].padStart(5, "0") : "",
    title: cleanTitle,
    description: cleanDescription,
    observedLabel: String(observedLabel || "").trim()
  };
  return {
    ...notification,
    receiptKey: stableHash([
      notification.title,
      notification.description,
      notification.observedLabel
    ].join("|"))
  };
}

const DASH_MONTHS = Object.freeze({
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
});

function parseDashLongDate(value) {
  const match = String(value || "").trim().match(/^(?:[A-Za-z]+,\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!match) return "";
  const month = DASH_MONTHS[match[2].toLowerCase()];
  if (!month) return "";
  return `${match[3]}-${month}-${String(Number(match[1])).padStart(2, "0")}`;
}

function parseDashDurationMinutes(value) {
  const text = String(value || "").toLowerCase();
  const hours = Number(text.match(/(\d+)\s*h/)?.[1] || 0);
  const minutes = Number(text.match(/(\d+)\s*min/)?.[1] || 0);
  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}

function parseDashAppointmentDetail({ text, url = "", clientHint = "", clientUrl = "" } = {}) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const detailsIndex = lines.findIndex(line => (
    line === "Appointment Details" || line === "View Appointment"
  ));
  const searchIndex = lines.findIndex(line => line === "Search Client");
  const client = String(
    searchIndex >= 0 ? lines[searchIndex + 1] || "" : clientHint || ""
  ).trim();
  const dateLine = lines.find(line => parseDashLongDate(line)) || "";
  const date = parseDashLongDate(dateLine);
  const timeLine = lines.find(line => /^\d{1,2}:\d{2}\s*(?:am|pm)$/i.test(line)) || "";
  const startMinutes = timeToMinutes(timeLine);
  const durationStaffIndex = lines.findIndex(line => (
    /^\s*(?:(?:\d+\s*h)(?:\s*\d+\s*min)?|\d+\s*min)\s*-\s*.*$/i.test(line)
  ));
  const durationStaffLine = durationStaffIndex >= 0 ? lines[durationStaffIndex] : "";
  const durationMinutes = parseDashDurationMinutes(durationStaffLine);
  const inlineStaffName = durationStaffLine.match(/-\s*(.+)$/)?.[1]?.trim() || "";
  const staffName = inlineStaffName || String(lines[durationStaffIndex + 1] || "").trim();
  const timeIndex = lines.indexOf(timeLine);
  const serviceLine = timeIndex >= 0 ? String(lines[timeIndex + 1] || "") : "";
  const service = serviceLine.replace(/\s+-\s+\$\s*[\d,.]+.*$/, "").trim();
  const aid = String(url || "").match(/[?&]aid=([^&#]+)/)?.[1] || "";
  const dashClientId = String(clientUrl || "").match(/[?&]cid=([^&#]+)/)?.[1] || "";
  const start = startMinutes === null ? null : minutesToSlot(startMinutes);
  const duration = durationMinutes && durationMinutes % SLOT_MINUTES === 0
    ? durationMinutes / SLOT_MINUTES
    : null;

  if (
    detailsIndex < 0 || !aid || !client || !date || !Number.isInteger(start) ||
    start < 0 || !Number.isInteger(duration) || duration < 1 || !staffName || !service
  ) return null;

  return {
    dashBookingId: decodeURIComponent(aid),
    dashClientId: dashClientId ? decodeURIComponent(dashClientId) : "",
    client,
    date,
    start,
    duration,
    service,
    staffName,
    sourceUrl: String(url || ""),
    ...parseDashAppointmentState({ text })
  };
}

function parseDashAppointmentState({ text } = {}) {
  const raw = String(text || "").replace(/\r/g, "");
  const cancellationReason = raw.match(/Canceled reason:\s*([^\n]+)/i)?.[1]?.trim() || "";
  const canceledByClient = /(?:^|\n)Canceled by Client(?:\n|$)/i.test(raw);
  const rescheduled = raw.match(
    /Rescheduled on Dash Booking:\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*(?:→|->)\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/i
  );
  return {
    dashStatus: canceledByClient || cancellationReason ? "canceled" : "confirmed",
    canceledByClient,
    cancellationReason,
    previousDate: rescheduled?.[1] || "",
    previousTime: rescheduled?.[2] || "",
    rescheduledDate: rescheduled?.[3] || "",
    rescheduledTime: rescheduled?.[4] || ""
  };
}

function getDashRequestDocumentId(dashBookingId) {
  return `dash_${stableHash(dashBookingId).slice(0, 40)}`;
}

function buildDashAppointment(detail, localStaff) {
  if (!detail?.dashBookingId || !localStaff?.id) return null;
  return {
    date: detail.date,
    staffId: localStaff.id,
    start: detail.start,
    duration: detail.duration,
    client: detail.client,
    note: detail.service,
    groupTag: null,
    noShow: false,
    canceled: false,
    cancelComment: null,
    type: "appointment",
    source: DASH_SOURCE,
    status: "confirmed",
    requestWarning: null,
    dashBookingId: detail.dashBookingId,
    dashOriginBookingId: detail.dashBookingId,
    dashStaffName: detail.staffName,
    selectedServices: [detail.service],
    privacySchemaVersion: detail.dashClientId ? 1 : null,
    hasPrivateContact: false,
    hasClientHistory: Boolean(detail.dashClientId),
    lastEditedBy: DASH_ACTOR_LABEL,
    lastAction: "dash_appointment_added",
    lastMutationMode: "dash_import",
    revision: 1
  };
}

// Keep the old export temporarily so historical tests and any queued warm
// instance can load the module during the staged rollout. New code uses the
// confirmed-appointment name above.
const buildDashRequestAppointment = buildDashAppointment;

function rangesOverlap(startA, endA, startB, endB) {
  return Number(startA) < Number(endB) && Number(startB) < Number(endA);
}

function findDashRequestConflict({ detail, appointments = [], offWork = [] } = {}) {
  if (!detail) return { conflict: true, reason: "invalid-detail" };
  const end = Number(detail.start) + Number(detail.duration);
  const appointment = appointments.find(item => {
    if (!item || item.canceled === true || item.noShow === true) return false;
    if (item.staffId !== detail.staffId || item.date !== detail.date) return false;
    if (String(item.dashBookingId || "") === String(detail.dashBookingId || "")) return false;
    return rangesOverlap(detail.start, end, item.start, Number(item.start) + Math.max(Number(item.duration) || 1, 1));
  });
  if (appointment) return { conflict: true, reason: "appointment", conflictingId: appointment.id || "" };

  const blocked = offWork.find(item => {
    if (!item || item.staffId !== detail.staffId || item.date !== detail.date) return false;
    if (item.weeklyException === true) return false;
    const itemStart = item.allDay === true ? 0 : Number(item.start);
    const itemEnd = item.allDay === true ? 49 : Number(item.end);
    return rangesOverlap(detail.start, end, itemStart, itemEnd);
  });
  if (blocked) return { conflict: true, reason: "off-work", conflictingId: blocked.id || "" };
  return { conflict: false };
}

function buildDashStaffMessage(detail, { eventType = "dash_appointment_added", conflict = null, previous = null } = {}) {
  const startMinutes = slotToMinutes(detail.start);
  const endMinutes = startMinutes + detail.duration * SLOT_MINUTES;
  const range = `${detail.date}, ${minutesToTime(startMinutes)}-${minutesToTime(endMinutes)}`;
  if (eventType === "dash_appointment_canceled") {
    const reason = String(detail.cancellationReason || "").trim();
    return [
      "DASH BOOKING CANCELED",
      `${detail.client} canceled the appointment with ${detail.staffName}.`,
      `${detail.date} at ${minutesToTime(startMinutes)}. The time is available now.`,
      ...(reason ? ["", `Reason: ${reason}`] : [])
    ].join("\n");
  }
  if (eventType === "dash_appointment_rescheduled") {
    const previousStaff = String(previous?.staffName || detail.staffName || "").trim();
    const oldDate = String(previous?.date || detail.previousDate || "").trim();
    const oldTime = String(previous?.time || detail.previousTime || "").trim();
    const lines = [
      "DASH BOOKING RESCHEDULED",
      `${detail.client}'s appointment with ${detail.staffName} was changed.`,
      "",
      `From: ${oldDate || "previous date"}, ${oldTime || "previous time"}`,
      `To: ${detail.date}, ${minutesToTime(startMinutes)}`,
      detail.service
    ];
    if (previousStaff && previousStaff !== detail.staffName) {
      lines.push(`Technician changed from ${previousStaff} to ${detail.staffName}.`);
    }
    return lines.join("\n");
  }
  const lines = [
    "DASH BOOKING APPOINTMENT",
    `${detail.client} booked with ${detail.staffName}.`,
    range,
    detail.service
  ];
  if (conflict?.conflict) {
    lines.push("");
    lines.push(conflict.reason === "off-work"
      ? "This Dash appointment is already confirmed, but the technician is off during this time. Please resolve the conflict."
      : "This Dash appointment is already confirmed, but the time overlaps the salon calendar. Please resolve the conflict.");
  } else {
    lines.push("");
    lines.push("Added to the calendar automatically.");
  }
  return lines.join("\n");
}

module.exports = {
  DASH_BLOCK_PREFIX,
  DASH_ACTOR_LABEL,
  DASH_CLOSE_MINUTES,
  DASH_OPEN_MINUTES,
  DASH_REQUEST_TYPE,
  DASH_SOURCE,
  DASH_STAFF_DIRECTORY,
  SLOT_MINUTES,
  appointmentToDashBlock,
  buildBlockDescription,
  buildCanonicalBlockKey,
  buildBlockFingerprint,
  buildDashRequestAppointment,
  buildDashAppointment,
  buildDashStaffMessage,
  buildQueueId,
  clipMinutesToDashHours,
  findDashRequestConflict,
  getDashRequestDocumentId,
  getCanonicalBlockInterval,
  getDirectoryEntryByDashName,
  isDashOriginAppointment,
  minutesToSlot,
  minutesToTime,
  normalizeStaffName,
  offWorkToDashBlock,
  parseDashAppointmentDetail,
  parseDashAppointmentState,
  parseDashDurationMinutes,
  parseDashLongDate,
  parseDashNotification,
  planQueueOperation,
  rangesOverlap,
  resolveDashStaff,
  resolveLocalStaffForDashName,
  slotToMinutes,
  stableHash,
  timeToMinutes
};
