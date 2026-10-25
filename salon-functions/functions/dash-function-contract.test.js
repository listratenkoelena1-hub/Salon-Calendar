"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const functionsSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const runnerSource = fs.readFileSync(path.join(__dirname, "dash-sync-runner.js"), "utf8");

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
  assert.match(functionsSource, /pollingWindow\.morningReconciliation && config\.dailyReconciliationEnabled && !config\.monitorOnly/);
  assert.match(functionsSource, /getDailyReconciliationWindows\(today, config\.horizonDays\)/);
  assert.doesNotMatch(functionsSource, /enqueueDashReconciliation\(\{ db, FieldValue, horizonDays: 0 \}\)/);
  assert.match(functionsSource, /secrets: \[DASH_BOOKING_EMAIL, DASH_BOOKING_PASSWORD\]/);
  assert.match(functionsSource, /if \(!config\.enabled\) return \{ skipped: true, reason: "disabled" \};/);
});

test("monitor-only mode cannot queue or execute outbound Dash changes", () => {
  assert.match(functionsSource, /if \(!config\.enabled \|\| config\.monitorOnly\) return \{ skipped: true/);
  assert.match(functionsSource, /after\.enabled !== true \|\| after\.monitorOnly === true/);
  assert.match(runnerSource, /dryRun: config\.monitorOnly \|\| !config\.writeEnabled/);
  assert.match(runnerSource, /config\.monitorOnly[\s\S]*?processDashMonitorAlerts/);
  assert.match(runnerSource, /queue = config\.monitorOnly[\s\S]*?reason: "monitor_only"/);
  assert.match(runnerSource, /status: "alerted"[\s\S]*?monitorOnly: true/);
  assert.match(functionsSource, /exports\.addDashMonitorAppointment = onCall/);
  assert.match(functionsSource, /allowConflictRetry: true/);
  assert.match(functionsSource, /requestedByLabel: actor\.label/);
  assert.match(functionsSource, /requestedByKey: actor\.staffId \|\| actor\.uid/);
  assert.match(runnerSource, /visibleToAllStaff: true/);
  assert.match(runnerSource, /dashImportReceiptId: entityId/);
});

test("does not expose the retired in-calendar Dash audit callables", () => {
  assert.doesNotMatch(functionsSource, /exports\.managerRunDashBookingAudit/);
  assert.doesNotMatch(functionsSource, /exports\.managerGetLatestDashBookingAudit/);
  assert.doesNotMatch(functionsSource, /exports\.managerApplyDashBookingAudit/);
  assert.doesNotMatch(runnerSource, /auditSummaryOnly/);
  assert.match(runnerSource, /createDashBrowserClient\(page, \{ dryRun: true \}\)/);
});
