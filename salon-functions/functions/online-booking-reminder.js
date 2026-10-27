"use strict";

const DEFAULT_TIME_ZONE = "America/Edmonton";
const REMINDER_LEAD_MINUTES = 3 * 60;
const REMINDER_WINDOW_MINUTES = 5;
const MAX_SINGLE_SMS_CHARACTERS = 160;

function parseDateKey(dateKey) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function getZonedDateTimeParts(date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function toLocalMinuteIndex({ year, month, day, hour = 0, minute = 0 }) {
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute) / 60000);
}

function getMinutesUntilAppointment(appointment, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const dateParts = parseDateKey(appointment?.date);
  const start = Number(appointment?.start);
  if (!dateParts || !Number.isInteger(start) || start < 0 || start > 48) return NaN;
  const appointmentMinutes = toLocalMinuteIndex({
    ...dateParts,
    hour: 8 + Math.floor((start * 15) / 60),
    minute: (start * 15) % 60
  });
  return appointmentMinutes - toLocalMinuteIndex(getZonedDateTimeParts(now, timeZone));
}

function isOnlineBookingReminderDue(appointment, options = {}) {
  if (!appointment || appointment.source !== "online_booking") return false;
  if (appointment.status !== "confirmed") return false;
  if (appointment.canceled === true || appointment.noShow === true) return false;
  if (appointment.smsConsent === false) return false;
  const leadMinutes = Number(options.leadMinutes) || REMINDER_LEAD_MINUTES;
  const windowMinutes = Number(options.windowMinutes) || REMINDER_WINDOW_MINUTES;
  const minutesUntil = getMinutesUntilAppointment(
    appointment,
    options.now || new Date(),
    options.timeZone || DEFAULT_TIME_ZONE
  );
  return Number.isFinite(minutesUntil) &&
    minutesUntil >= leadMinutes - windowMinutes &&
    minutesUntil <= leadMinutes + windowMinutes;
}

function formatReminderDate(dateKey) {
  const parts = parseDateKey(dateKey);
  if (!parts) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)));
}

function formatReminderTime(start) {
  const slot = Number(start);
  if (!Number.isInteger(slot) || slot < 0 || slot > 48) return "";
  const totalMinutes = 8 * 60 + slot * 15;
  const hour24 = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function buildOnlineBookingReminderBody({ date, start, staffName, salonPhone }) {
  const dateText = formatReminderDate(date);
  const timeText = formatReminderTime(start);
  const prefix = `Hello from Roses Nails! You have an appointment on ${dateText} at ${timeText} with `;
  const suffix = `. If your plans change, please call ${salonPhone}.`;
  const fallbackName = "your technician";
  const requestedName = String(staffName || "").trim() || fallbackName;
  const availableNameLength = Math.max(1, MAX_SINGLE_SMS_CHARACTERS - prefix.length - suffix.length);
  const safeName = requestedName.slice(0, availableNameLength).trim() || fallbackName.slice(0, availableNameLength);
  return `${prefix}${safeName}${suffix}`;
}

function getReminderDateKeys(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const offsets = [
    REMINDER_LEAD_MINUTES - REMINDER_WINDOW_MINUTES,
    REMINDER_LEAD_MINUTES + REMINDER_WINDOW_MINUTES
  ];
  return [...new Set(offsets.map(offset => {
    const parts = getZonedDateTimeParts(new Date(now.getTime() + offset * 60000), timeZone);
    return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  }))];
}

module.exports = {
  DEFAULT_TIME_ZONE,
  MAX_SINGLE_SMS_CHARACTERS,
  REMINDER_LEAD_MINUTES,
  REMINDER_WINDOW_MINUTES,
  buildOnlineBookingReminderBody,
  formatReminderDate,
  formatReminderTime,
  getMinutesUntilAppointment,
  getReminderDateKeys,
  isOnlineBookingReminderDue
};
