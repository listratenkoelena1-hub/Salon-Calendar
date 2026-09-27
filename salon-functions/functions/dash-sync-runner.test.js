"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addDateKeyDays,
  buildDashActivityLogDoc,
  buildDashMessageDoc,
  buildDefaultConfig,
  dashCycleNeedsBrowser,
  dateKeyInTimeZone,
  getDashPollingWindow,
  getWeeklyOffOccurrencesForDate,
  isTerminalIncomingStatus,
  makeWeeklyOccurrence,
  weekdayForDateKey,
  weeklyRuleActiveOnDate
} = require("./dash-sync-runner");

test("keeps the Dash bridge disabled unless the server config explicitly enables it", () => {
  assert.deepEqual(buildDefaultConfig(), {
    enabled: false,
    writeEnabled: false,
    inboundEnabled: false,
    inboundBaselineComplete: false,
    initialApplyEnabled: false,
    dailyReconciliationEnabled: true,
    horizonDays: 30,
    queueLimit: 25
  });
  assert.deepEqual(buildDefaultConfig({
    enabled: true,
    writeEnabled: true,
    inboundEnabled: true,
    inboundBaselineComplete: false,
    horizonDays: 999,
    queueLimit: 0
  }), {
    enabled: true,
    writeEnabled: true,
    inboundEnabled: true,
    inboundBaselineComplete: false,
    initialApplyEnabled: false,
    dailyReconciliationEnabled: true,
    horizonDays: 30,
    queueLimit: 1
  });
});

test("retries incomplete incoming receipts but not terminal Dash outcomes", () => {
  assert.equal(isTerminalIncomingStatus("imported"), true);
  assert.equal(isTerminalIncomingStatus("canceled"), true);
  assert.equal(isTerminalIncomingStatus("rescheduled"), true);
  assert.equal(isTerminalIncomingStatus("conflict"), true);
  assert.equal(isTerminalIncomingStatus("duplicate"), true);
  assert.equal(isTerminalIncomingStatus("baseline"), true);
  assert.equal(isTerminalIncomingStatus("baseline_parse_error"), true);
  assert.equal(isTerminalIncomingStatus("unmapped_staff"), false);
  assert.equal(isTerminalIncomingStatus("parse_error"), false);
});

test("starts Chromium only for inbound polling or real pending writes", () => {
  assert.equal(dashCycleNeedsBrowser({ inboundEnabled: false, writeEnabled: false }, false), false);
  assert.equal(dashCycleNeedsBrowser({ inboundEnabled: false, writeEnabled: false }, true), false);
  assert.equal(dashCycleNeedsBrowser({ inboundEnabled: false, writeEnabled: true }, false), false);
  assert.equal(dashCycleNeedsBrowser({ inboundEnabled: false, writeEnabled: true }, true), true);
  assert.equal(dashCycleNeedsBrowser({ inboundEnabled: true, writeEnabled: false }, false), true);
});

test("polls Dash hourly before opening and every fifteen minutes from 9 AM through 7 PM", () => {
  const atEdmonton = (hour, minute = 0) => new Date(Date.UTC(2026, 8, 25, hour + 6, minute));

  assert.deepEqual(getDashPollingWindow(atEdmonton(6), "America/Edmonton"), {
    shouldRun: true,
    morningReconciliation: true,
    hour: 6,
    minute: 0,
    phase: "morning_reconciliation"
  });
  assert.equal(getDashPollingWindow(atEdmonton(6, 15), "America/Edmonton").shouldRun, false);
  assert.equal(getDashPollingWindow(atEdmonton(7), "America/Edmonton").phase, "morning_hourly");
  assert.equal(getDashPollingWindow(atEdmonton(8), "America/Edmonton").shouldRun, true);
  assert.equal(getDashPollingWindow(atEdmonton(9), "America/Edmonton").phase, "business_quarter_hour");
  assert.equal(getDashPollingWindow(atEdmonton(12, 15), "America/Edmonton").shouldRun, true);
  assert.equal(getDashPollingWindow(atEdmonton(18, 45), "America/Edmonton").shouldRun, true);
  assert.equal(getDashPollingWindow(atEdmonton(19), "America/Edmonton").shouldRun, true);
  assert.equal(getDashPollingWindow(atEdmonton(19, 15), "America/Edmonton").shouldRun, false);
  assert.equal(getDashPollingWindow(atEdmonton(5, 45), "America/Edmonton").phase, "closed");
});

test("handles reconciliation date keys without local DST drift", () => {
  assert.equal(addDateKeyDays("2026-03-07", 1), "2026-03-08");
  assert.equal(addDateKeyDays("2026-03-08", 1), "2026-03-09");
  assert.equal(weekdayForDateKey("2026-09-25"), 5);
  assert.equal(dateKeyInTimeZone(new Date("2026-09-26T05:30:00Z"), "America/Edmonton"), "2026-09-25");
});

test("expands active weekly off-work rules and honors start and end dates", () => {
  const fridayRule = {
    id: "weekly-1",
    staffId: "staff-1",
    weekday: 5,
    startDate: "2026-09-01",
    endDate: "2026-10-31",
    allDay: false,
    start: 8,
    end: 12,
    enabled: true
  };
  assert.equal(weeklyRuleActiveOnDate(fridayRule, "2026-09-25"), true);
  assert.equal(weeklyRuleActiveOnDate(fridayRule, "2026-09-24"), false);
  assert.equal(weeklyRuleActiveOnDate(fridayRule, "2026-11-06"), false);
  assert.deepEqual(makeWeeklyOccurrence(fridayRule, "2026-09-25"), {
    id: "weekly_weekly-1_2026-09-25",
    date: "2026-09-25",
    staffId: "staff-1",
    allDay: false,
    start: 8,
    end: 12,
    weeklyRuleId: "weekly-1"
  });
  assert.equal(getWeeklyOffOccurrencesForDate([fridayRule], "2026-09-25", "staff-1").length, 1);
});

test("builds one canonical Important message for manager and assigned technician", () => {
  const FieldValue = { serverTimestamp: () => "SERVER_TIME" };
  const Timestamp = { fromDate: date => ({ millis: date.getTime() }) };
  const message = buildDashMessageDoc({
    FieldValue,
    Timestamp,
    message: "DASH BOOKING APPOINTMENT",
    eventType: "dash_appointment_added",
    entityType: "appointment",
    entityId: "dash_123",
    staffId: "staff-1",
    staffName: "Tanya",
    staffRecords: [
      { id: "staff-1", active: true },
      { id: "staff-2", active: true },
      { id: "retired", active: false },
      { id: "anyone", active: true }
    ]
  });
  assert.deepEqual(message.audienceStaffIds, ["staff-1", "staff-2"]);
  assert.deepEqual(message.importantStaffIds, ["staff-1"]);
  assert.equal(message.managerPriority, "key");
  assert.equal(message.staffDefaultPriority, "secondary");
  assert.equal(message.source, "dash_booking");
  assert.equal(message.title, "Dash Booking appointment");
});

test("uses distinct titles for ongoing Dash cancellation and reschedule events", () => {
  const FieldValue = { serverTimestamp: () => "SERVER_TIME" };
  const Timestamp = { fromDate: date => ({ millis: date.getTime() }) };
  const base = {
    FieldValue,
    Timestamp,
    message: "Dash event",
    entityType: "appointment",
    entityId: "dash_123",
    staffId: "staff-1",
    staffName: "Tanya",
    staffRecords: [{ id: "staff-1", active: true }]
  };
  assert.equal(buildDashMessageDoc({
    ...base,
    eventType: "dash_appointment_canceled"
  }).title, "Dash Booking canceled");
  assert.equal(buildDashMessageDoc({
    ...base,
    eventType: "dash_appointment_rescheduled"
  }).title, "Dash Booking rescheduled");
});

test("builds a phone-free Dash activity log entry", () => {
  const FieldValue = { serverTimestamp: () => "SERVER_TIME" };
  const entry = buildDashActivityLogDoc({
    FieldValue,
    detail: {
      date: "2026-10-03",
      client: "Sample Client",
      service: "Pedicure"
    },
    eventType: "dash_appointment_added",
    entityType: "appointment",
    entityId: "dash_123",
    staffId: "staff-1",
    message: "DASH BOOKING APPOINTMENT"
  });

  assert.equal(entry.actorLabel, "DashBooking");
  assert.equal(entry.logDate, "2026-10-03");
  assert.equal(entry.hasPrivateContact, false);
  assert.equal(Object.hasOwn(entry, "phone"), false);
});
