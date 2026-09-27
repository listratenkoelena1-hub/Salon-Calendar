"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);

test("shows ongoing Dash events as normal calendar events without a new confirmation action", () => {
  assert.match(calendarHtml, /dash_appointment_added: 'Dash Booking appointment'/);
  assert.match(calendarHtml, /dash_appointment_rescheduled: 'Dash Booking rescheduled'/);
  assert.match(calendarHtml, /dash_appointment_canceled: 'Dash Booking canceled'/);
  assert.match(calendarHtml, /value: 'dash_booking', label: '@DashBooking'/);
});

test("archive preserves Dash Booking as a distinct appointment source", () => {
  assert.match(calendarHtml, /option value="dash_booking">Dash Booking/);
  assert.match(calendarHtml, /a\?\.source === 'dash_booking'/);
});

test("calendar interface has no experimental Dash audit window or callable dependency", () => {
  assert.doesNotMatch(calendarHtml, /dashAuditPreviewBtn/);
  assert.doesNotMatch(calendarHtml, /Dash Booking audit/);
  assert.doesNotMatch(calendarHtml, /managerRunDashBookingAudit/);
  assert.doesNotMatch(calendarHtml, /managerGetLatestDashBookingAudit/);
  assert.doesNotMatch(calendarHtml, /get\('dashAudit'\)/);
});
