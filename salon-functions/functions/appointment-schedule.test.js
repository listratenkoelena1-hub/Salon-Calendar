"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildScheduleSlots,
  findScheduleOverlaps,
  releaseAppointmentFromSlots,
  reserveAppointmentSlots
} = require("./appointment-schedule");

function appointment(id, start, duration, overrides = {}) {
  return {
    id,
    date: "2026-08-21",
    staffId: "olga",
    start,
    duration,
    canceled: false,
    noShow: false,
    ...overrides
  };
}

test("rejects a 12:00 appointment over a 10:00-13:00 appointment", () => {
  const existing = appointment("first", 8, 12);
  const candidate = appointment("second", 16, 4);
  const slots = buildScheduleSlots([existing], { date: existing.date, staffId: existing.staffId });

  assert.throws(
    () => reserveAppointmentSlots(slots, candidate, candidate.id),
    error => error.code === "appointment-conflict" &&
      error.conflictingAppointmentIds.includes(existing.id)
  );
});

test("allows an adjacent appointment beginning at 13:00", () => {
  const existing = appointment("first", 8, 12);
  const candidate = appointment("second", 20, 4);
  const slots = buildScheduleSlots([existing], { date: existing.date, staffId: existing.staffId });

  const next = reserveAppointmentSlots(slots, candidate, candidate.id);
  assert.deepEqual(next.slot_20, ["second"]);
});

test("canceling releases every occupied slot", () => {
  const existing = appointment("first", 8, 12);
  const slots = buildScheduleSlots([existing], { date: existing.date, staffId: existing.staffId });
  const released = releaseAppointmentFromSlots(slots, existing, existing.id);

  assert.deepEqual(released, {});
});

test("restoring a canceled appointment is rejected when its former time was taken", () => {
  const replacement = appointment("replacement", 8, 4);
  const restored = appointment("restored", 8, 4);
  const slots = buildScheduleSlots([replacement], { date: replacement.date, staffId: replacement.staffId });

  assert.throws(
    () => reserveAppointmentSlots(slots, restored, restored.id),
    error => error.code === "appointment-conflict"
  );
});

test("moving releases the old range before reserving the new range", () => {
  const original = appointment("moving", 8, 4);
  const moved = appointment("moving", 16, 4);
  let slots = buildScheduleSlots([original], { date: original.date, staffId: original.staffId });
  slots = releaseAppointmentFromSlots(slots, original, original.id);
  slots = reserveAppointmentSlots(slots, moved, moved.id);

  assert.equal(slots.slot_8, undefined);
  assert.deepEqual(slots.slot_16, ["moving"]);
});

test("legacy overlaps remain visible and can be repaired by deleting either owner", () => {
  const first = appointment("first", 8, 12);
  const second = appointment("second", 16, 4);
  const slots = buildScheduleSlots([first, second], { date: first.date, staffId: first.staffId });

  assert.deepEqual(slots.slot_16, ["first", "second"]);
  assert.ok(findScheduleOverlaps(slots).length > 0);

  const repaired = releaseAppointmentFromSlots(slots, second, second.id);
  assert.deepEqual(repaired.slot_16, ["first"]);
  assert.deepEqual(findScheduleOverlaps(repaired), []);
});

test("two sequential reservations of the same slot cannot both succeed", () => {
  const first = appointment("first", 16, 4);
  const second = appointment("second", 16, 4);
  const committedSlots = reserveAppointmentSlots({}, first, first.id);

  assert.throws(
    () => reserveAppointmentSlots(committedSlots, second, second.id),
    error => error.code === "appointment-conflict"
  );
});

test("the special Morning slot is protected too", () => {
  const first = appointment("first", -1, 1);
  const second = appointment("second", -1, 1);
  const slots = buildScheduleSlots([first], { date: first.date, staffId: first.staffId });

  assert.throws(
    () => reserveAppointmentSlots(slots, second, second.id),
    error => error.code === "appointment-conflict"
  );
});
