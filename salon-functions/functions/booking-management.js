"use strict";

function normalizePhoneDigits(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length === 10 ? digits : "";
}

function normalizeClientName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-CA")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildPhoneLookupVariants(value) {
  const raw = String(value || "").trim();
  const digits = normalizePhoneDigits(raw);
  if (!digits) return raw ? [raw] : [];

  const area = digits.slice(0, 3);
  const prefix = digits.slice(3, 6);
  const line = digits.slice(6);
  return Array.from(new Set([
    raw,
    digits,
    `1${digits}`,
    `+1${digits}`,
    `${area}-${prefix}-${line}`,
    `${area} ${prefix} ${line}`,
    `(${area}) ${prefix}-${line}`,
    `+1 ${area}-${prefix}-${line}`,
    `+1 (${area}) ${prefix}-${line}`
  ])).slice(0, 30);
}

function isOnlineBookingAppointment(appointment) {
  return Boolean(
    appointment &&
    (appointment.source === "online_booking" || appointment.type === "online_booking_request")
  );
}

function isUpcomingAppointmentForClient(appointment, {
  phoneDigits,
  clientName,
  today,
  currentMinutes
}) {
  if (!isOnlineBookingAppointment(appointment)) return false;
  if (appointment.canceled === true || appointment.noShow === true || appointment.status === "declined") return false;
  if (!["request", "confirmed"].includes(String(appointment.status || ""))) return false;

  const appointmentPhone = normalizePhoneDigits(appointment.phoneLookup || appointment.phone);
  if (!appointmentPhone || appointmentPhone !== phoneDigits) return false;

  const appointmentName = normalizeClientName(appointment.client);
  if (!appointmentName || appointmentName !== clientName) return false;

  const date = String(appointment.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) return false;
  if (date > today) return true;

  const start = Number(appointment.start);
  if (!Number.isFinite(start) || start < 0) return true;
  return (8 * 60) + (start * 15) >= currentMinutes;
}

function timestampToMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return Number(value.toMillis()) || 0;
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") return Date.parse(value) || 0;
  if (Number.isFinite(value.seconds)) return Number(value.seconds) * 1000;
  if (Number.isFinite(value._seconds)) return Number(value._seconds) * 1000;
  return 0;
}

function getPhotoRetentionDeadlineMs(appointment, ttlMs, fallbackNowMs = Date.now()) {
  const status = String(appointment?.status || "");
  if (!["confirmed", "declined"].includes(status)) return null;

  const decisionTimestamp = status === "confirmed"
    ? appointment.confirmedAt
    : appointment.declinedAt;
  const decisionMs = timestampToMillis(decisionTimestamp) || fallbackNowMs;
  return decisionMs + ttlMs;
}

module.exports = {
  buildPhoneLookupVariants,
  getPhotoRetentionDeadlineMs,
  isUpcomingAppointmentForClient,
  normalizeClientName,
  normalizePhoneDigits,
  timestampToMillis
};
