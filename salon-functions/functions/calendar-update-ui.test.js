"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);
const serviceWorkerSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "sw.js"),
  "utf8"
);

test("calendar update control is hidden until a new version is ready", () => {
  assert.match(calendarHtml, /id="calendarUpdateBtn"[\s\S]*?class="hidden"/);
  assert.match(calendarHtml, /function showCalendarUpdateButton\(\)/);
  assert.match(calendarHtml, /registration\.waiting && navigator\.serviceWorker\.controller/);
  assert.match(calendarHtml, /newWorker\.state === 'installed' && navigator\.serviceWorker\.controller/);
});

test("Update activates the waiting worker and reloads after controller change", () => {
  assert.match(calendarHtml, /function applyCalendarUpdate\(\)/);
  assert.match(calendarHtml, /waitingWorker\.postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
  assert.match(calendarHtml, /addEventListener\('controllerchange'/);
  assert.match(calendarHtml, /window\.location\.reload\(\)/);
});

test("service worker waits for the user's update action", () => {
  assert.doesNotMatch(serviceWorkerSource, /addEventListener\('install'[\s\S]*?skipWaiting/);
  assert.match(serviceWorkerSource, /event\.data\.type === 'SKIP_WAITING'/);
  assert.match(serviceWorkerSource, /salon-cache-v5/);
});
