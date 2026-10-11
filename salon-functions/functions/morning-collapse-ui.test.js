"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);

function loadMorningSelector() {
  const start = calendarHtml.indexOf("function getCollapsedMorningAppointment(appointmentList)");
  const end = calendarHtml.indexOf("function drawCollapsedMorningAppointment", start);
  const source = start >= 0 && end > start ? calendarHtml.slice(start, end).trim() : "";
  assert.ok(source, "Morning selector source was not found");
  const context = { MORNING_SLOTS: 8 };
  vm.runInNewContext(`${source}\nthis.selectMorning = getCollapsedMorningAppointment;`, context);
  return context.selectMorning;
}

test("collapsed Morning selects one visible appointment deterministically", () => {
  assert.match(calendarHtml, /function getCollapsedMorningAppointment\(appointmentList\)/);
  assert.match(calendarHtml, /aEnd >= MORNING_SLOTS/);
  assert.match(calendarHtml, /bEnd >= MORNING_SLOTS/);
  assert.match(calendarHtml, /if \(aReachesTen !== bReachesTen\)/);
  assert.match(calendarHtml, /if \(aReachesTen && aStart !== bStart\) return bStart - aStart/);
  assert.match(calendarHtml, /if \(aEnd !== bEnd\) return bEnd - aEnd/);

  const selectMorning = loadMorningSelector();
  assert.equal(selectMorning([
    { id: "early", start: 2, duration: 1 },
    { id: "nine-thirty", start: 6, duration: 1 }
  ]).id, "nine-thirty");
  assert.equal(selectMorning([
    { id: "crosses-ten", start: 6, duration: 5 },
    { id: "ends-at-ten", start: 7, duration: 1 },
    { id: "before-ten", start: 6, duration: 1 }
  ]).id, "ends-at-ten");
  assert.equal(selectMorning([
    { id: "unscheduled-morning", start: -1, duration: 1 },
    { id: "timed-morning", start: 5, duration: 1 }
  ]).id, "timed-morning");
});

test("collapsed Morning includes Anyone and ordinary technician appointments", () => {
  assert.match(calendarHtml, /staff\.forEach\(\(person, staffIndex\) => \{[\s\S]*?dayAppointments\.filter\(a => a\.staffId === person\.id\)/);
  assert.match(calendarHtml, /if \(!morningExpanded && Number\(start\) < MORNING_SLOTS\) return/);
  assert.match(calendarHtml, /drawCollapsedMorningAppointment\([\s\S]*?morningAppointment/);
});

test("week view also keeps a collapsed Morning indicator", () => {
  assert.match(calendarHtml, /weekDateStrings\.forEach\(dateStr => \{[\s\S]*?getCollapsedMorningAppointment\([\s\S]*?a\.date === dateStr/);
  assert.match(calendarHtml, /data-slot="-1"\]\[data-date="\$\{dateStr\}"\]/);
});
