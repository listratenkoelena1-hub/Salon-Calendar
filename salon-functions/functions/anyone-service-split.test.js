"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildHandsFeetSplitRequest } = require("./anyone-service-split");

const functionsSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

test("builds sequential hand and foot service inputs for an Anyone request", () => {
  const split = buildHandsFeetSplitRequest({
    selectedServices: ["Manicure + Gel Polish", "Spa Pedicure + Gel Polish"],
    serviceDetails: "Manicure + Gel Polish, Spa Pedicure + Gel Polish",
    requestedGroups: ["manicure", "pedicure"]
  });
  assert.equal(split.hands.intent.hands.key, "gel_polish");
  assert.equal(split.feet.intent.feet.key, "gel_polish");
  assert.deepEqual(split.hands.requestedGroups, ["manicure"]);
  assert.deepEqual(split.feet.requestedGroups, ["pedicure"]);
});

test("does not split a single nail service or requests containing brows and waxing", () => {
  assert.equal(buildHandsFeetSplitRequest({
    serviceDetails: "Manicure gel polish",
    requestedGroups: ["manicure"]
  }), null);
  assert.equal(buildHandsFeetSplitRequest({
    serviceDetails: "Manicure gel polish, Pedicure gel polish, brow wax",
    requestedGroups: ["manicure", "pedicure", "brows"]
  }), null);
  assert.equal(buildHandsFeetSplitRequest({
    serviceDetails: "Removing; Manicure gel polish; Pedicure gel polish",
    requestedGroups: ["manicure", "pedicure"]
  }), null);
});

test("the Anyone backend checks one technician first and creates two linked records only as fallback", () => {
  assert.match(functionsSource, /anyoneAssignment = selectAnyoneCandidate\([\s\S]*?if \(!anyoneAssignment\) \{[\s\S]*?getSequentialAnyoneSplitPlan/);
  assert.match(functionsSource, /onlineBookingGroupAppointmentIds: groupAppointmentIds/);
  assert.match(functionsSource, /onlineBookingSegment: "feet"/);
  assert.match(functionsSource, /tx\.set\(secondaryAppointmentRef, secondaryAppointmentData\)/);
  assert.match(functionsSource, /suppressClientNotifications: true/);
});
