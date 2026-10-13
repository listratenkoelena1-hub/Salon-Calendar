"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);

test("off-work modal exposes one optional comment field above a horizontal time range", () => {
  const commentIndex = calendarHtml.indexOf('id="offComment"');
  const timeRangeIndex = calendarHtml.indexOf('id="offTimeRange"');

  assert.ok(commentIndex > 0);
  assert.ok(timeRangeIndex > commentIndex);
  assert.match(calendarHtml, /class="off-time-range-row"[\s\S]*id="offStart"[\s\S]*id="offEnd"/);
});

test("off-work comments are normalized, persisted for every source, and rendered once per block", () => {
  assert.match(calendarHtml, /function normalizeOffWorkComment\(value\)/);
  assert.match(calendarHtml, /function renderOffWorkComment\(cells, occurrence\)/);
  assert.match(calendarHtml, /overlay\.textContent = comment/);
  assert.match(calendarHtml, /updateDoc\(doc\(db, 'WeeklyOff', existingWeeklyId\), \{ comment \}\)/);
  assert.match(calendarHtml, /where\('vacationId', '==', existingVacationId\)/);
  assert.match(calendarHtml, /vacationId,[\s\S]*comment/);
  assert.match(calendarHtml, /extraFields: \{ comment \}/);
});

test("off-work comment card fades only when its text overflows", () => {
  assert.match(calendarHtml, /\.off-work-comment-overlay\.has-overflow/);
  assert.match(calendarHtml, /overlay\.scrollHeight > overlay\.clientHeight \+ 1/);
});

test("messenger notifications include comments for every off-work source", () => {
  assert.match(calendarHtml, /function buildOffWorkCommentLine\(data\)/);
  assert.match(calendarHtml, /Comment: \$\{escapeHtml\(comment\)\}/);
  assert.match(calendarHtml, /buildTelegramOffWorkCreatedMessage[\s\S]*buildOffWorkCommentLine\(data\)/);
  assert.match(calendarHtml, /buildTelegramWeeklyOffMessage[\s\S]*buildOffWorkCommentLine\(data\)/);
  assert.match(calendarHtml, /buildTelegramVacationMessage[\s\S]*buildOffWorkCommentLine\(data\)/);
  assert.match(calendarHtml, /buildTelegramWeeklyOffCommentMessage/);
  assert.match(calendarHtml, /buildTelegramVacationCommentMessage/);
  assert.match(calendarHtml, /finished for today[\s\S]*buildOffWorkCommentLine/);
});
