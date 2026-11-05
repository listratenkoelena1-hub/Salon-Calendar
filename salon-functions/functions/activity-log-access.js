"use strict";

const ACTIVITY_LOG_PAGE_LIMIT = 500;
const PHONE_LIKE_PATTERN = /(?<!\d)(?:\+?1[\s().-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}(?!\d)/g;
const PHONE_CHANGE_PATTERN = /(^|[;:]\s*)phone\s+[^;]*/gi;

function redactPhoneLikeText(value, { redactPhoneChanges = false } = {}) {
  let text = String(value || "");
  text = text.replace(PHONE_LIKE_PATTERN, "[phone hidden]");
  if (redactPhoneChanges) {
    text = text.replace(PHONE_CHANGE_PATTERN, (_match, prefix) => `${prefix}phone [hidden]`);
  }
  return text;
}

function timestampToMillis(value) {
  if (value && typeof value.toMillis === "function") {
    const milliseconds = Number(value.toMillis());
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  return null;
}

function getActivityLogCreatedAtSearchRange(dateKey) {
  const center = Date.parse(`${String(dateKey || "")}T12:00:00.000Z`);
  if (!Number.isFinite(center)) return null;
  return {
    start: new Date(center - 36 * 60 * 60 * 1000),
    end: new Date(center + 36 * 60 * 60 * 1000)
  };
}

function isVisibleActivityLogEventType(eventType) {
  const normalized = String(eventType || "");
  return !normalized.startsWith("dash_") || normalized === "dash_appointment_added";
}

function normalizeActivityLogDisplayFields(data = {}) {
  const isLegacyOnlineClientCancellation = data.eventType === "canceled" &&
    (data.actorKey === "online_booking_client" || data.lastMutationMode === "online_client_cancel");
  if (!isLegacyOnlineClientCancellation) return data;
  return {
    ...data,
    actorLabel: "Online Booking",
    actorKey: "online_booking",
    eventType: "online_client_canceled"
  };
}

function serializeStaffActivityLogEntry(document) {
  const rawData = document?.data && typeof document.data === "function"
    ? document.data() || {}
    : (document?.data || {});
  const data = normalizeActivityLogDisplayFields(rawData);
  return {
    id: String(document?.id || ""),
    createdAtMillis: timestampToMillis(data.createdAt),
    logDate: String(data.logDate || ""),
    actorLabel: redactPhoneLikeText(data.actorLabel),
    actorKey: String(data.actorKey || ""),
    staffId: String(data.staffId || ""),
    staffName: redactPhoneLikeText(data.staffName),
    eventType: String(data.eventType || ""),
    entityType: String(data.entityType || ""),
    entityId: String(data.entityId || ""),
    client: redactPhoneLikeText(data.client),
    service: redactPhoneLikeText(data.service),
    details: redactPhoneLikeText(data.details, { redactPhoneChanges: true }),
    source: String(data.source || "")
  };
}

module.exports = {
  ACTIVITY_LOG_PAGE_LIMIT,
  getActivityLogCreatedAtSearchRange,
  isVisibleActivityLogEventType,
  normalizeActivityLogDisplayFields,
  redactPhoneLikeText,
  serializeStaffActivityLogEntry,
  timestampToMillis
};
