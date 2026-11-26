"use strict";

const {
  getNameMatch,
  isCompatibleClientName,
  normalizeClientName,
  parseServiceIntent
} = require("./client-history-core");

const DUPLICATE_BOOKING_WINDOW_DAYS = 14;
const SLOT_MINUTES = 15;
const CALENDAR_START_MINUTES = 8 * 60;

function dateKeyToUtcMs(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return 0;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addDateKeyDays(value, days) {
  const millis = dateKeyToUtcMs(value);
  if (!millis) return "";
  return new Date(millis + Number(days || 0) * 86400000).toISOString().slice(0, 10);
}

function getDuplicateBookingDateRange(dateKeys, windowDays = DUPLICATE_BOOKING_WINDOW_DAYS) {
  const valid = (Array.isArray(dateKeys) ? dateKeys : [dateKeys])
    .map(value => String(value || ""))
    .filter(value => dateKeyToUtcMs(value));
  if (!valid.length) return null;
  valid.sort();
  return {
    startDate: addDateKeyDays(valid[0], -windowDays),
    endDate: addDateKeyDays(valid[valid.length - 1], windowDays)
  };
}

function getServiceFamilies(value = {}) {
  const selectedServices = Array.isArray(value.selectedServices) ? value.selectedServices : [];
  const serviceText = String(
    value.serviceDetails ?? value.note ?? value.service ?? ""
  ).trim();
  const intent = value.serviceIntent && typeof value.serviceIntent === "object"
    ? value.serviceIntent
    : parseServiceIntent({ selectedServices, serviceDetails: serviceText });
  const families = new Set();
  if (intent?.hands?.key) families.add("hands");
  if (intent?.feet?.key) families.add("feet");
  const text = `${selectedServices.join(" ")} ${serviceText}`.toLocaleLowerCase("en-CA");
  if (/\b(?:lash|lashes|eyelash|eyelashes)\b/u.test(text)) families.add("lashes");
  if (/\b(?:brow|brows|eyebrow|eyebrows|wax|waxing)\b/u.test(text)) families.add("brows_waxing");
  return [...families];
}

function namesMayReferToSameClient(left, right) {
  const normalizedLeft = normalizeClientName(left);
  const normalizedRight = normalizeClientName(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (isCompatibleClientName(normalizedLeft, normalizedRight)) return true;
  return Boolean(getNameMatch(normalizedLeft, normalizedRight));
}

function servicesMayBeDuplicates(left, right) {
  const leftFamilies = new Set(getServiceFamilies(left));
  const rightFamilies = getServiceFamilies(right);
  return Boolean(leftFamilies.size && rightFamilies.some(family => leftFamilies.has(family)));
}

function isActiveBookingCandidate(candidate) {
  if (!candidate || candidate.canceled === true || candidate.noShow === true) return false;
  const status = String(candidate.status || "").toLocaleLowerCase("en-CA");
  return ![
    "canceled", "cancelled", "declined", "deleted", "monitor_ignored",
    "baseline", "baseline_parse_error", "parse_error"
  ].includes(status);
}

function sameBooking(left, right) {
  const pairs = [
    [left.id, right.id],
    [left.appointmentId, right.appointmentId],
    [left.dashBookingId, right.dashBookingId],
    [left.onlineBookingGroupId, right.onlineBookingGroupId]
  ];
  return pairs.some(([a, b]) => Boolean(a && b && String(a) === String(b)));
}

function dedupeBookingCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = candidate.dashBookingId
      ? `dash:${candidate.dashBookingId}`
      : candidate.appointmentId || candidate.id
        ? `appointment:${candidate.appointmentId || candidate.id}`
        : [candidate.source, candidate.client, candidate.date, candidate.start, candidate.service].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findPossibleDuplicateBookings(incoming, candidates, {
  windowDays = DUPLICATE_BOOKING_WINDOW_DAYS
} = {}) {
  const incomingDateMs = dateKeyToUtcMs(incoming?.date);
  if (!incomingDateMs || !normalizeClientName(incoming?.client) || !getServiceFamilies(incoming).length) return [];
  const matches = (Array.isArray(candidates) ? candidates : []).filter(candidate => {
    if (!isActiveBookingCandidate(candidate) || sameBooking(incoming, candidate)) return false;
    if (!["online_booking", "dash_booking"].includes(String(candidate.source || ""))) return false;
    const candidateDateMs = dateKeyToUtcMs(candidate.date);
    if (!candidateDateMs || Math.abs(candidateDateMs - incomingDateMs) > windowDays * 86400000) return false;
    return namesMayReferToSameClient(incoming.client, candidate.client) &&
      servicesMayBeDuplicates(incoming, candidate);
  });
  return dedupeBookingCandidates(matches).sort((left, right) => {
    const leftDistance = Math.abs(dateKeyToUtcMs(left.date) - incomingDateMs);
    const rightDistance = Math.abs(dateKeyToUtcMs(right.date) - incomingDateMs);
    return leftDistance - rightDistance || String(left.date).localeCompare(String(right.date)) ||
      Number(left.start || 0) - Number(right.start || 0);
  });
}

function appointmentToDuplicateCandidate(appointment = {}) {
  return {
    id: String(appointment.id || ""),
    appointmentId: String(appointment.id || appointment.appointmentId || ""),
    dashBookingId: String(appointment.dashBookingId || appointment.dashOriginBookingId || ""),
    onlineBookingGroupId: String(appointment.onlineBookingGroupId || ""),
    source: String(appointment.source || ""),
    client: String(appointment.client || ""),
    date: String(appointment.date || ""),
    start: Number(appointment.start),
    note: String(appointment.note || ""),
    serviceIntent: appointment.serviceIntent || null,
    selectedServices: Array.isArray(appointment.selectedServices) ? appointment.selectedServices : [],
    status: String(appointment.status || ""),
    canceled: appointment.canceled === true,
    noShow: appointment.noShow === true
  };
}

function dashReceiptToDuplicateCandidate(receipt = {}) {
  const detail = receipt.detail || {};
  return {
    id: String(receipt.id || receipt.notificationKey || ""),
    appointmentId: String(receipt.appointmentId || receipt.localAppointmentId || ""),
    dashBookingId: String(receipt.dashBookingId || detail.dashBookingId || ""),
    source: "dash_booking",
    client: String(detail.client || ""),
    date: String(detail.date || ""),
    start: Number(detail.start),
    service: String(detail.service || ""),
    status: String(detail.dashStatus === "canceled" ? "canceled" : receipt.status || ""),
    canceled: detail.canceledByClient === true || detail.dashStatus === "canceled",
    noShow: false
  };
}

function formatDuplicateBookingDate(dateKey) {
  const millis = dateKeyToUtcMs(dateKey);
  if (!millis) return String(dateKey || "an unknown date");
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(new Date(millis));
}

function formatDuplicateBookingTime(start) {
  const minutes = CALENDAR_START_MINUTES + Number(start || 0) * SLOT_MINUTES;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${String(mins).padStart(2, "0")} ${suffix}`;
}

function getBookingSourceLabel(source) {
  return source === "dash_booking" ? "Dash Booking" : "Online Booking";
}

function buildPossibleDuplicateBookingWarning(matches) {
  const items = Array.isArray(matches) ? matches : [];
  if (!items.length) return "";
  if (items.length === 1) {
    const match = items[0];
    return [
      "⚠️ POSSIBLE DUPLICATE BOOKING",
      `A client with the same or a similar name may already have a similar appointment on ${formatDuplicateBookingDate(match.date)} at ${formatDuplicateBookingTime(match.start)} through ${getBookingSourceLabel(match.source)}.`
    ].join("\n");
  }
  return [
    "⚠️ POSSIBLE DUPLICATE BOOKING",
    "Similar appointments were found for a client with the same or a similar name."
  ].join("\n");
}

module.exports = {
  DUPLICATE_BOOKING_WINDOW_DAYS,
  addDateKeyDays,
  appointmentToDuplicateCandidate,
  buildPossibleDuplicateBookingWarning,
  dashReceiptToDuplicateCandidate,
  findPossibleDuplicateBookings,
  getDuplicateBookingDateRange,
  getServiceFamilies,
  namesMayReferToSameClient,
  servicesMayBeDuplicates
};
