"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ACTIVITY_LOG_PAGE_LIMIT,
  getActivityLogCreatedAtSearchRange,
  isVisibleActivityLogEventType,
  normalizeActivityLogDisplayFields,
  redactPhoneLikeText,
  serializeStaffActivityLogEntry,
  timestampToMillis
} = require("./activity-log-access");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);
const functionsSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

test("phone-like text is removed from staff-visible log content", () => {
  assert.equal(redactPhoneLikeText("Call 780-555-0123"), "Call [phone hidden]");
  assert.equal(redactPhoneLikeText("Call +1 (780) 555-0123"), "Call [phone hidden]");
  assert.equal(
    redactPhoneLikeText("changed: phone 7805550123 -> 7805550199; service refill", {
      redactPhoneChanges: true
    }),
    "changed: phone [hidden]; service refill"
  );
  assert.equal(redactPhoneLikeText("Tuesday, September 16, 2026 at 2:00 PM"),
    "Tuesday, September 16, 2026 at 2:00 PM");
});

test("staff serializer returns only safe activity-log fields", () => {
  const entry = serializeStaffActivityLogEntry({
    id: "log-one",
    data: () => ({
      createdAt: { toMillis: () => 1_700_000_000_123 },
      logDate: "2026-09-16",
      actorLabel: "Manager",
      actorKey: "manager",
      staffId: "tech-one",
      staffName: "Tech One",
      eventType: "updated_app",
      entityType: "appointment",
      entityId: "appointment-one",
      client: "Naomi 7805550123",
      phone: "7805550123",
      email: "private@example.test",
      service: "Refill; call (780) 555-0123",
      details: "Naomi; changed: phone 7805550123 -> -; duration 2 hr",
      source: "calendar",
      unexpectedPrivateField: "must not pass through"
    })
  });

  assert.deepEqual(Object.keys(entry), [
    "id", "createdAtMillis", "logDate", "actorLabel", "actorKey", "staffId",
    "staffName", "eventType", "entityType", "entityId", "client", "service",
    "details", "source"
  ]);
  assert.equal(entry.createdAtMillis, 1_700_000_000_123);
  assert.equal(entry.client, "Naomi [phone hidden]");
  assert.equal(entry.service, "Refill; call [phone hidden]");
  assert.equal(entry.details, "Naomi; changed: phone [hidden]; duration 2 hr");
  assert.equal("phone" in entry, false);
  assert.equal("email" in entry, false);
  assert.equal("unexpectedPrivateField" in entry, false);
});

test("timestamp conversion and server page limit stay bounded", () => {
  assert.equal(timestampToMillis(new Date("2026-09-16T12:00:00Z")), 1_789_560_000_000);
  assert.equal(timestampToMillis(null), null);
  assert.equal(ACTIVITY_LOG_PAGE_LIMIT, 500);
});

test("daily Log searches by action timestamp instead of appointment date", () => {
  const range = getActivityLogCreatedAtSearchRange("2026-11-05");
  assert.equal(range.start.toISOString(), "2026-11-04T00:00:00.000Z");
  assert.equal(range.end.toISOString(), "2026-11-07T00:00:00.000Z");
  assert.match(functionsSource, /\.where\("createdAt", ">=", Timestamp\.fromDate\(createdAtRange\.start\)\)/);
  assert.doesNotMatch(functionsSource, /\.where\("logDate", "==", logDate\)/);
  assert.doesNotMatch(calendarHtml, /where\('logDate', '==', dateStr\)/);
});

test("daily Log keeps only the initial Dash addition event", () => {
  assert.equal(isVisibleActivityLogEventType("dash_appointment_added"), true);
  assert.equal(isVisibleActivityLogEventType("dash_appointment_rescheduled"), false);
  assert.equal(isVisibleActivityLogEventType("dash_appointment_canceled"), false);
  assert.equal(isVisibleActivityLogEventType("dash_appointment_conflict"), false);
  assert.equal(isVisibleActivityLogEventType("updated_app"), true);
});

test("legacy client cancellations use the current Online Booking Log label", () => {
  assert.deepEqual(normalizeActivityLogDisplayFields({
    actorLabel: "Online Booking Client",
    actorKey: "online_booking_client",
    eventType: "canceled"
  }), {
    actorLabel: "Online Booking",
    actorKey: "online_booking",
    eventType: "online_client_canceled"
  });
});

test("Log offers the client cancellation event and hides non-addition Dash event filters", () => {
  assert.match(calendarHtml, /value="online_client_canceled">Online cancellation by client/);
  assert.match(calendarHtml, /value="dash_appointment_added">Dash Booking added/);
  assert.doesNotMatch(calendarHtml, /value="dash_appointment_rescheduled">Dash Booking changed/);
  assert.doesNotMatch(calendarHtml, /value="dash_appointment_canceled">Dash Booking canceled/);
  assert.doesNotMatch(calendarHtml, /value="dash_appointment_conflict">Dash Booking conflict/);
  assert.doesNotMatch(calendarHtml, /value: 'dash_booking', label: '@DashBooking'/);
  assert.doesNotMatch(calendarHtml, /where\('logDate', '==', dateStr\)/);
});
