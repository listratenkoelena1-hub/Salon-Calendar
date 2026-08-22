"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { canMutateAnyAppointment } = require("./appointment-access");

test("staff can mutate appointments assigned to any technician", () => {
  assert.equal(canMutateAnyAppointment("staff"), true);
});

test("manager and reception retain calendar-wide appointment access", () => {
  assert.equal(canMutateAnyAppointment("manager"), true);
  assert.equal(canMutateAnyAppointment("reception"), true);
});

test("unknown roles cannot mutate appointments", () => {
  assert.equal(canMutateAnyAppointment(""), false);
  assert.equal(canMutateAnyAppointment("customer"), false);
});
