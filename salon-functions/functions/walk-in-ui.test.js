"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);

test("Walk In defaults to the signed-in technician but allows reassignment", () => {
  const walkInHandler = calendarHtml.match(
    /window\.openWalkIn = \(\) => \{[\s\S]*?^\};/m
  )?.[0] || "";

  assert.match(walkInHandler, /setAppointmentReadonly\(false\)/);
  assert.match(walkInHandler, /aStaff\.value = getCurrentStaffId\(\)/);
  assert.match(walkInHandler, /aStaff\.disabled = false/);
  assert.match(walkInHandler, /aStaff\.style\.opacity = '1'/);
  assert.doesNotMatch(walkInHandler, /aStaff\.disabled = true/);
});
