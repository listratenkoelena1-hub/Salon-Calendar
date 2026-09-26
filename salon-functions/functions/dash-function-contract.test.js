"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const functionsSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

test("registers disabled-by-default Dash triggers and protected scheduled credentials", () => {
  assert.match(functionsSource, /exports\.dashAppointmentWritten = onDocumentWritten/);
  assert.match(functionsSource, /exports\.dashOffWorkWritten = onDocumentWritten/);
  assert.match(functionsSource, /exports\.dashWeeklyOffWritten = onDocumentWritten/);
  assert.match(functionsSource, /exports\.dashStaffMappingWritten = onDocumentWritten/);
  assert.match(functionsSource, /exports\.dashSyncConfigWritten = onDocumentWritten/);
  assert.match(functionsSource, /exports\.dashSyncEveryFifteenMinutes = onSchedule/);
  assert.doesNotMatch(functionsSource, /exports\.dashReconcileDaily = onSchedule/);
  assert.match(functionsSource, /getDashPollingWindow\(new Date\(\), SALON_TIME_ZONE\)/);
  assert.match(functionsSource, /reason: "outside_active_hours"/);
  assert.match(functionsSource, /pollingWindow\.morningReconciliation && config\.dailyReconciliationEnabled/);
  assert.match(functionsSource, /secrets: \[DASH_BOOKING_EMAIL, DASH_BOOKING_PASSWORD\]/);
  assert.match(functionsSource, /if \(!config\.enabled\) return \{ skipped: true, reason: "disabled" \};/);
});

test("confirms Dash requests without permitting a Dash decline path", () => {
  assert.match(functionsSource, /function isPendingDashRequest\(appointment\)/);
  assert.match(functionsSource, /source: confirmingDashRequest \? "dash_booking" : "online_booking"/);
  assert.match(functionsSource, /\? "dash_request_confirmed"\s*: "online_request_confirmed"/);
  assert.doesNotMatch(functionsSource, /dash_request_declined/);
});
