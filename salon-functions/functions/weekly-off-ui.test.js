"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);

test("both weekly-off creation paths reject an overlapping equivalent rule", () => {
  assert.match(calendarHtml, /function findEquivalentWeeklyOffRule\(candidate\)/);
  assert.equal((calendarHtml.match(/findEquivalentWeeklyOffRule\(weeklyData\)/g) || []).length, 2);
  assert.match(calendarHtml, /This weekly off already exists/);
});
