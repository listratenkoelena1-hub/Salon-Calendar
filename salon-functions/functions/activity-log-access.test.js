"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACTIVITY_LOG_PAGE_LIMIT,
  redactPhoneLikeText,
  serializeStaffActivityLogEntry,
  timestampToMillis
} = require("./activity-log-access");

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
