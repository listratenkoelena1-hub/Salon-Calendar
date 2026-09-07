"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildPhoneLookupVariants,
  getPhotoRetentionDeadlineMs,
  isUpcomingAppointmentForClient,
  normalizeClientName,
  normalizePhoneDigits
} = require("./booking-management");

const lookup = {
  phoneDigits: "7805551212",
  clientName: "alex smith",
  today: "2026-09-06",
  currentMinutes: 12 * 60
};

function appointment(overrides = {}) {
  return {
    source: "online_booking",
    type: "appointment",
    status: "confirmed",
    canceled: false,
    noShow: false,
    client: "Alex Smith",
    phone: "+1 (780) 555-1212",
    date: "2026-09-07",
    start: 20,
    ...overrides
  };
}

test("normalizes Canadian phone numbers and client names for private lookup", () => {
  assert.equal(normalizePhoneDigits("+1 (780) 555-1212"), "7805551212");
  assert.equal(normalizeClientName("  ALEX   Smith "), "alex smith");
  assert.ok(buildPhoneLookupVariants("7805551212").includes("(780) 555-1212"));
});

test("finds pending and confirmed future online appointments for the same client", () => {
  assert.equal(isUpcomingAppointmentForClient(appointment(), lookup), true);
  assert.equal(isUpcomingAppointmentForClient(appointment({
    type: "online_booking_request",
    status: "request"
  }), lookup), true);
});

test("does not expose unrelated, canceled, declined, mismatched, or past appointments", () => {
  assert.equal(isUpcomingAppointmentForClient(appointment({ source: null }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ canceled: true }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ status: "declined" }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ client: "Someone Else" }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ phone: "7805550000" }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ date: "2026-09-05" }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ date: "2026-09-06", start: 12 }), lookup), false);
});

test("starts the photo deletion clock 24 hours after confirmation or decline", () => {
  const ttl = 24 * 60 * 60 * 1000;
  const confirmedAt = Date.UTC(2026, 8, 6, 18, 0, 0);
  const declinedAt = Date.UTC(2026, 8, 7, 2, 30, 0);

  assert.equal(
    getPhotoRetentionDeadlineMs({ status: "confirmed", confirmedAt }, ttl),
    confirmedAt + ttl
  );
  assert.equal(
    getPhotoRetentionDeadlineMs({ status: "declined", declinedAt }, ttl),
    declinedAt + ttl
  );
  assert.equal(getPhotoRetentionDeadlineMs({ status: "request" }, ttl), null);
});
