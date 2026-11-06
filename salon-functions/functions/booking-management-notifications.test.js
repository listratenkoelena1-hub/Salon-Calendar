"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const functionsSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const smsFunctionSource = functionsSource.match(
  /function buildBookingSmsContent\(eventType, data\) \{[\s\S]*?\r?\n\}\r?\n\r?\nfunction buildBookingSmsQueueDoc/
)?.[0].replace(/\r?\n\r?\nfunction buildBookingSmsQueueDoc$/, "");

assert.ok(smsFunctionSource, "SMS content builder should be extractable");
const buildBookingSmsContent = new Function(
  `${smsFunctionSource}\nreturn buildBookingSmsContent;`
)();

test("client cancellation SMS is concise and identifies Roses Nails", () => {
  const body = buildBookingSmsContent("booking_canceled", {
    bookingDate: "Nov 8",
    bookingTime: "2:00 PM",
    staffName: "Olena"
  });
  assert.equal(
    body,
    "Roses Nails: Your appointment on Nov 8 at 2:00 PM has been cancelled. We hope to see you again soon."
  );
  assert.ok(body.length <= 160);
});

test("client reschedule SMS includes the previous and new appointment", () => {
  const body = buildBookingSmsContent("booking_rescheduled", {
    previousBookingDate: "Nov 8",
    previousBookingTime: "2:00 PM",
    bookingDate: "Nov 10",
    bookingTime: "3:30 PM",
    staffName: "Natalia"
  });
  assert.equal(
    body,
    "Roses Nails: Your appointment was moved from Nov 8 at 2:00 PM to Nov 10 at 3:30 PM with Natalia. See you then!"
  );
  assert.ok(body.length <= 160);
});

test("management callables queue one-time SMS and optional email notifications", () => {
  assert.match(functionsSource, /eventType: "booking_canceled"/);
  assert.match(functionsSource, /eventType: "booking_rescheduled"/);
  assert.match(functionsSource, /Your Roses Nails appointment has been cancelled/);
  assert.match(functionsSource, /Your Roses Nails appointment has been rescheduled/);
  assert.match(functionsSource, /getBookingEmailContactExpiry\(after\.date\)/);
  assert.match(functionsSource, /previousAppointmentData: before/);
});

