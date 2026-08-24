"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldProcessStaffPush } = require("./push-notification");

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
