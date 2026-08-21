"use strict";

const SCHEDULE_SCHEMA_VERSION = 1;

function isActiveAppointment(appointment) {
  return Boolean(
    appointment &&
    appointment.canceled !== true &&
    appointment.noShow !== true
  );
}

function isRealStaffAppointment(appointment, anyoneId = "anyone") {
  return Boolean(
    appointment &&
    appointment.staffId &&
    appointment.staffId !== anyoneId
  );
}

function appointmentUsesSchedule(appointment, anyoneId = "anyone") {
  return isActiveAppointment(appointment) && isRealStaffAppointment(appointment, anyoneId);
}

function getScheduleId(date, staffId) {
  const dateValue = String(date || "");
  const staffValue = String(staffId || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !staffValue || staffValue.includes("/")) {
    throw new Error("Invalid appointment schedule key.");
  }
  return `${dateValue}__${staffValue}`;
}

function getAppointmentSlotKeys(appointment) {
  const start = Number(appointment?.start);
  const duration = Number(appointment?.duration);
  if (!Number.isInteger(start) || !Number.isInteger(duration) || duration < 1) {
    throw new Error("Invalid appointment slot range.");
  }

  return Array.from({ length: duration }, (_, offset) => `slot_${start + offset}`);
}

function normalizeSlotOwners(value) {
  const raw = Array.isArray(value) ? value : (typeof value === "string" ? [value] : []);
  return [...new Set(raw.map(item => String(item || "").trim()).filter(Boolean))].sort();
}

function cloneSlots(slots = {}) {
  return Object.fromEntries(
    Object.entries(slots || {})
      .map(([key, value]) => [key, normalizeSlotOwners(value)])
      .filter(([, owners]) => owners.length)
  );
}

function addAppointmentToSlots(slots, appointment, appointmentId) {
  const next = cloneSlots(slots);
  if (!appointmentUsesSchedule(appointment)) return next;

  const owner = String(appointmentId || "").trim();
  if (!owner) throw new Error("Appointment id is required.");

  for (const key of getAppointmentSlotKeys(appointment)) {
    next[key] = normalizeSlotOwners([...(next[key] || []), owner]);
  }
  return next;
}

function releaseAppointmentFromSlots(slots, appointment, appointmentId) {
  const next = cloneSlots(slots);
  if (!appointmentUsesSchedule(appointment)) return next;

  const owner = String(appointmentId || "").trim();
  for (const key of getAppointmentSlotKeys(appointment)) {
    const remaining = normalizeSlotOwners(next[key]).filter(item => item !== owner);
    if (remaining.length) next[key] = remaining;
    else delete next[key];
  }
  return next;
}

function getAppointmentConflicts(slots, appointment, appointmentId) {
  if (!appointmentUsesSchedule(appointment)) return [];
  const owner = String(appointmentId || "").trim();
  const conflicts = new Set();

  for (const key of getAppointmentSlotKeys(appointment)) {
    for (const existingOwner of normalizeSlotOwners(slots?.[key])) {
      if (existingOwner !== owner) conflicts.add(existingOwner);
    }
  }
  return [...conflicts].sort();
}

function reserveAppointmentSlots(slots, appointment, appointmentId) {
  const conflicts = getAppointmentConflicts(slots, appointment, appointmentId);
  if (conflicts.length) {
    const error = new Error("Appointment overlaps an existing appointment.");
    error.code = "appointment-conflict";
    error.conflictingAppointmentIds = conflicts;
    throw error;
  }
  return addAppointmentToSlots(slots, appointment, appointmentId);
}

function buildScheduleSlots(appointments = [], { date, staffId, anyoneId = "anyone" } = {}) {
  return appointments.reduce((slots, appointment) => {
    if (!appointmentUsesSchedule(appointment, anyoneId)) return slots;
    if (date && appointment.date !== date) return slots;
    if (staffId && appointment.staffId !== staffId) return slots;
    return addAppointmentToSlots(slots, appointment, appointment.id);
  }, {});
}

function findScheduleOverlaps(slots = {}) {
  return Object.entries(cloneSlots(slots))
    .filter(([, owners]) => owners.length > 1)
    .map(([slotKey, appointmentIds]) => ({ slotKey, appointmentIds }));
}

module.exports = {
  SCHEDULE_SCHEMA_VERSION,
  addAppointmentToSlots,
  appointmentUsesSchedule,
  buildScheduleSlots,
  cloneSlots,
  findScheduleOverlaps,
  getAppointmentConflicts,
  getAppointmentSlotKeys,
  getScheduleId,
  isActiveAppointment,
  isRealStaffAppointment,
  normalizeSlotOwners,
  releaseAppointmentFromSlots,
  reserveAppointmentSlots
};
