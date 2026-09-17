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

function serializeStaffActivityLogEntry(document) {
  const data = document?.data && typeof document.data === "function"
    ? document.data() || {}
    : (document?.data || {});
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
  redactPhoneLikeText,
  serializeStaffActivityLogEntry,
  timestampToMillis
};
