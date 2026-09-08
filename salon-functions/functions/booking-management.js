"use strict";

const crypto = require("crypto");

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
  const wasCancelledByClient = status === "cancelled" && appointment?.canceled === true;
  if (!["confirmed", "declined"].includes(status) && !wasCancelledByClient) return null;

  const decisionTimestamp = status === "confirmed"
    ? appointment.confirmedAt
    : (status === "declined" ? appointment.declinedAt : appointment.canceledAt);
  const decisionMs = timestampToMillis(decisionTimestamp) || fallbackNowMs;
  return decisionMs + ttlMs;
}

function getClientCancellationRecordState(appointment = {}) {
  const wasPendingRequest = appointment.status === "request";
  return {
    type: wasPendingRequest ? "appointment" : appointment.type,
    status: wasPendingRequest ? "cancelled" : appointment.status,
    canceled: true
  };
}

function buildVerificationCodeHash({ challengeId, code, secret }) {
  const safeChallengeId = String(challengeId || "");
  const safeCode = String(code || "");
  const safeSecret = String(secret || "");
  if (!safeChallengeId || !/^\d{6}$/.test(safeCode) || !safeSecret) return "";
  return crypto
    .createHmac("sha256", safeSecret)
    .update(`${safeChallengeId}:${safeCode}`)
    .digest("hex");
}

function buildSessionTokenHash(value) {
  const token = String(value || "");
  return token ? crypto.createHash("sha256").update(token).digest("hex") : "";
}

function secureHashesEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (!leftBuffer.length || leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getVerificationRateDecision(rateData, nowMs, {
  cooldownMs = 60 * 1000,
  windowMs = 60 * 60 * 1000,
  maxSends = 3,
  dailyWindowMs = 24 * 60 * 60 * 1000,
  maxDailySends = 6
} = {}) {
  const safeNowMs = Number(nowMs);
  if (!Number.isFinite(safeNowMs)) throw new Error("A valid current time is required.");

  const lastSentAtMs = timestampToMillis(rateData?.lastSentAt);
  if (lastSentAtMs && safeNowMs - lastSentAtMs < cooldownMs) {
    return {
      allowed: false,
      reason: "cooldown",
      retryAfterSeconds: Math.max(1, Math.ceil((cooldownMs - (safeNowMs - lastSentAtMs)) / 1000))
    };
  }

  const storedWindowStartMs = timestampToMillis(rateData?.windowStartedAt);
  const withinWindow = storedWindowStartMs > 0 && safeNowMs - storedWindowStartMs < windowMs;
  const windowStartedAtMs = withinWindow ? storedWindowStartMs : safeNowMs;
  const sendCount = withinWindow ? Math.max(0, Number(rateData?.sendCount) || 0) : 0;

  if (sendCount >= maxSends) {
    return {
      allowed: false,
      reason: "hourly_limit",
      retryAfterSeconds: Math.max(1, Math.ceil((windowStartedAtMs + windowMs - safeNowMs) / 1000))
    };
  }

  const storedDailyWindowStartMs = timestampToMillis(rateData?.dailyWindowStartedAt);
  const withinDailyWindow = storedDailyWindowStartMs > 0 && safeNowMs - storedDailyWindowStartMs < dailyWindowMs;
  const dailyWindowStartedAtMs = withinDailyWindow ? storedDailyWindowStartMs : safeNowMs;
  const dailySendCount = withinDailyWindow ? Math.max(0, Number(rateData?.dailySendCount) || 0) : 0;

  if (dailySendCount >= maxDailySends) {
    return {
      allowed: false,
      reason: "daily_limit",
      retryAfterSeconds: Math.max(1, Math.ceil((dailyWindowStartedAtMs + dailyWindowMs - safeNowMs) / 1000))
    };
  }

  return {
    allowed: true,
    sendCount: sendCount + 1,
    windowStartedAtMs,
    dailySendCount: dailySendCount + 1,
    dailyWindowStartedAtMs,
    lastSentAtMs: safeNowMs
  };
}

module.exports = {
  buildSessionTokenHash,
  buildVerificationCodeHash,
  buildPhoneLookupVariants,
  getClientCancellationRecordState,
  getPhotoRetentionDeadlineMs,
  getVerificationRateDecision,
  isUpcomingAppointmentForClient,
  normalizeClientName,
  normalizePhoneDigits,
  secureHashesEqual,
  timestampToMillis
};
