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

test("Hosting preview offers a manager-only read-only Dash audit", () => {
  assert.match(calendarHtml, /host\.startsWith\('rosesnails-calendar--'\)/);
  assert.match(calendarHtml, /get\('dashAudit'\) === '1'/);
  assert.match(calendarHtml, /DASH_AUDIT_PREVIEW_ENABLED && currentUserRole === 'manager'/);
  assert.match(calendarHtml, /READ-ONLY · This check cannot create, change, cancel, or block any appointment/);
  assert.match(calendarHtml, /managerRunDashBookingAudit\(\{/);
  assert.match(calendarHtml, /Writes performed:/);
  assert.doesNotMatch(calendarHtml, /Apply audit plan/);
});
