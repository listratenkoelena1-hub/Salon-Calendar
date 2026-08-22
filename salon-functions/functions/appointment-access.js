"use strict";

const APPOINTMENT_MUTATION_ROLES = new Set(["manager", "reception", "staff"]);

function canMutateAnyAppointment(role) {
  return APPOINTMENT_MUTATION_ROLES.has(String(role || "").trim());
}

module.exports = {
  canMutateAnyAppointment
};
