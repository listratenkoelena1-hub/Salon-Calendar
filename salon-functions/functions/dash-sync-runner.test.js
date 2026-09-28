"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  addDateKeyDays,
  buildDashActivityLogDoc,
  buildDashMessageDoc,
  buildDashOutboundMismatchMessage,
  buildDefaultConfig,
  dashCycleNeedsBrowser,
  dateKeyInTimeZone,
  getDailyReconciliationWindows,
  getDashPollingWindow,
  getReconciliationRange,
  getWeeklyOffOccurrencesForDate,
  isTerminalIncomingStatus,
  makeWeeklyOccurrence,
  resolveStableDashLink,
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

test("accepts a synchronized Block Time only after its stable Dash id is known", () => {
  assert.equal(resolveStableDashLink({ observedKey: "visual-only" }), null);
  assert.deepEqual(resolveStableDashLink({
    dashBlockId: "dash-block-1",
    editUrl: "https://www.partnersdash.com/appointments/block-time?aid=dash-block-1"
  }), {
    dashBlockId: "dash-block-1",
    editUrl: "https://www.partnersdash.com/appointments/block-time?aid=dash-block-1"
  });
  assert.deepEqual(resolveStableDashLink({}, {
    dashBlockId: "dash-block-legacy",
    editUrl: "https://www.partnersdash.com/appointments/block-time?aid=dash-block-legacy"
  }), {
    dashBlockId: "dash-block-legacy",
    editUrl: "https://www.partnersdash.com/appointments/block-time?aid=dash-block-legacy"
  });
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

test("keeps a rolling window at exactly thirty calendar days", () => {
  assert.deepEqual(getReconciliationRange("2026-09-29", 30), {
    startDate: "2026-09-29",
    endDate: "2026-10-28",
    horizonDays: 30
  });
  assert.deepEqual(getDailyReconciliationWindows("2026-09-29", 30), [
    { startDate: "2026-09-29", horizonDays: 1, purpose: "today" },
    { startDate: "2026-10-28", horizonDays: 1, purpose: "rolling_edge" }
  ]);
  assert.deepEqual(getDailyReconciliationWindows("2026-09-29", 1), [
    { startDate: "2026-09-29", horizonDays: 1, purpose: "today" }
  ]);
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
  assert.equal(buildDashMessageDoc({
    ...base,
    eventType: "dash_appointment_time_mismatch",
    conflict: true
  }).title, "Dash Booking time mismatch");
});

test("warns about a shorter Rose interval without instructing the bridge to edit Dash", () => {
  const message = buildDashOutboundMismatchMessage({
    client: "Prit",
    date: "2026-09-28",
    start: 30,
    duration: 10,
    dashOriginDate: "2026-09-28",
    dashOriginStart: 30,
    dashOriginDuration: 12,
    dashOriginStaffName: "Olha"
  }, { name: "Olha" }, "dash-origin-shorter");

  assert.match(message, /DASH BOOKING TIME MISMATCH/);
  assert.match(message, /Rose Calendar: 2026-09-28, 15:30-18:00/);
  assert.match(message, /Dash Booking: 2026-09-28, 15:30-18:30/);
  assert.match(message, /Dash Booking was not changed/);
  assert.doesNotMatch(message, /updated automatically|shorten/i);
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
