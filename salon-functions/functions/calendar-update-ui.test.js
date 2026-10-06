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
const versionManifest = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "version.json"),
  "utf8"
));

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
  assert.match(calendarHtml, /function reloadCalendarForUpdate\(\)/);
  assert.match(calendarHtml, /window\.location\.replace\(url\.toString\(\)\)/);
});

test("service worker waits for the user's update action", () => {
  assert.doesNotMatch(serviceWorkerSource, /addEventListener\('install'[\s\S]*?skipWaiting/);
  assert.match(serviceWorkerSource, /event\.data\.type === 'SKIP_WAITING'/);
  assert.match(serviceWorkerSource, /salon-cache-v6/);
});

test("calendar checks a no-cache release manifest independently of the service worker", () => {
  assert.match(calendarHtml, /function checkCalendarAppVersion\(\)/);
  assert.match(calendarHtml, /fetch\(`\.\/version\.json\?check=\$\{Date\.now\(\)\}`,[\s\S]*?cache: 'no-store'/);
  assert.match(calendarHtml, /window\.setInterval\(checkCalendarAppVersion, 10 \* 60 \* 1000\)/);
  assert.match(calendarHtml, /visibilityState === 'visible'/);
  const embeddedVersion = calendarHtml.match(/const CALENDAR_APP_VERSION = '([^']+)'/)?.[1];
  assert.equal(embeddedVersion, versionManifest.version);
});
