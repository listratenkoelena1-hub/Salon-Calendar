"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { shouldProcessStaffPush } = require("./push-notification");

const functionsSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const dashSource = fs.readFileSync(path.join(__dirname, "dash-sync-runner.js"), "utf8");
const calendarSource = fs.readFileSync(path.join(__dirname, "../../salon-calendar/index.html"), "utf8");

test("processes a canonical key appointment even when an older client marked it ineligible", () => {
  assert.equal(shouldProcessStaffPush({
    audienceVersion: 2,
    managerPriority: "key",
    pushEligible: false
  }), true);
});

test("processes canonical chat messages and explicitly eligible legacy messages", () => {
  assert.equal(shouldProcessStaffPush({ audienceVersion: 2, managerPriority: "message" }), true);
  assert.equal(shouldProcessStaffPush({ pushEligible: true }), true);
});

test("does not send secondary or ineligible legacy messages", () => {
  assert.equal(shouldProcessStaffPush({ audienceVersion: 2, managerPriority: "secondary" }), false);
  assert.equal(shouldProcessStaffPush({ pushEligible: false }), false);
});

test("staff messages expire after thirty days and cleanup drains old backlogs", () => {
  assert.match(functionsSource, /STAFF_NOTIFICATION_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(dashSource, /STAFF_MESSAGE_TTL_MS = 30 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(calendarSource, /expiresAt: new Date\(Date\.now\(\) \+ 30 \* 24 \* 60 \* 60 \* 1000\)/);
  assert.match(functionsSource, /deleteExpiredStaffMessageBatches\("staffNotifications", now\)/);
  assert.match(functionsSource, /deleteExpiredStaffMessageBatches\("staffMessages", now\)/);
  assert.match(functionsSource, /batchSize = 400, maxBatches = 10/);
});
