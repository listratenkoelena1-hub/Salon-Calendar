"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);

test("renders Dash requests separately from internal online booking requests", () => {
  assert.match(calendarHtml, /function isPendingDashBookingRequest\(a\)/);
  assert.match(calendarHtml, /a\?\.type === 'dash_booking_request'/);
  assert.match(calendarHtml, /app-overlay\.dash-request/);
  assert.match(calendarHtml, /Dash Booking appointment\. Review the date/);
});

test("Dash requests expose Confirm but do not expose Decline", () => {
  assert.match(calendarHtml, /appointmentDeleteBtn\.classList\.toggle\('hidden', dashRequest\)/);
  assert.match(calendarHtml, /data-dash-confirm-id/);
  assert.match(calendarHtml, /confirmDashBookingRequestFromMessage/);
  assert.match(calendarHtml, /Dash Booking requests can only be confirmed/);
});

test("archive preserves Dash Booking as a distinct appointment source", () => {
  assert.match(calendarHtml, /option value="dash_booking">Dash Booking/);
  assert.match(calendarHtml, /a\?\.source === 'dash_booking'/);
});

test("Hosting preview offers a memory-only Dash demo without enabling it on production", () => {
  assert.match(calendarHtml, /host\.startsWith\('rosesnails-calendar--'\)/);
  assert.match(calendarHtml, /get\('dashDemo'\) === '1'/);
  assert.match(calendarHtml, /isDashPreviewDemo: true/);
  assert.match(calendarHtml, /function confirmDashPreviewDemoRequest/);
  assert.match(calendarHtml, /demo only\. Nothing was saved\./);
  assert.match(calendarHtml, /originalRaw\?\.isDashPreviewDemo === true/);
});
