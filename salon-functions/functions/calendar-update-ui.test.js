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
  assert.match(calendarHtml, /function hideCalendarUpdateButton\(\)/);
  assert.match(calendarHtml, /registration\.waiting && navigator\.serviceWorker\.controller/);
  assert.match(calendarHtml, /newWorker\.state === 'installed' && navigator\.serviceWorker\.controller/);
});

test("calendar update control stays at the lower-left edge", () => {
  const updateButtonCss = calendarHtml.match(/#calendarUpdateBtn \{([^}]+)\}/)?.[1] || '';
  assert.match(updateButtonCss, /left: 16px !important;/);
  assert.match(updateButtonCss, /right: auto !important;/);
  assert.match(updateButtonCss, /bottom: 90px;/);
  assert.match(updateButtonCss, /transform: none !important;/);
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
  assert.match(serviceWorkerSource, /salon-cache-v9/);
});

test("calendar checks a no-cache release manifest independently of the service worker", () => {
  assert.match(calendarHtml, /function checkCalendarAppVersion\(\{ autoApply = false \} = \{\}\)/);
  assert.match(calendarHtml, /fetch\(`\.\/version\.json\?check=\$\{Date\.now\(\)\}`,[\s\S]*?cache: 'no-store'/);
  assert.match(calendarHtml, /window\.setInterval\(checkCalendarAppVersion, 10 \* 60 \* 1000\)/);
  assert.match(calendarHtml, /visibilityState === 'visible'/);
  const embeddedVersion = calendarHtml.match(/const CALENDAR_APP_VERSION = '([^']+)'/)?.[1];
  assert.equal(embeddedVersion, versionManifest.version);
});

test("the Update control clears once the loaded release matches the manifest", () => {
  assert.match(calendarHtml, /availableVersion === CALENDAR_APP_VERSION[\s\S]*?calendarAvailableVersion = '';[\s\S]*?hideCalendarUpdateButton\(\)/);
  assert.match(calendarHtml, /addEventListener\('controllerchange'[\s\S]*?hideCalendarUpdateButton\(\);[\s\S]*?checkCalendarAppVersion\(\)/);
  assert.doesNotMatch(calendarHtml, /addEventListener\('controllerchange'[\s\S]*?showCalendarUpdateButton\(\);/);
});

test("a reopened or foregrounded calendar applies a pending update automatically", () => {
  assert.match(calendarHtml, /checkCalendarAppVersion\(\{ autoApply: true \}\)/);
  assert.match(calendarHtml, /visibilityState === 'visible'[\s\S]*?checkCalendarAppVersion\(\{ autoApply: true \}\)/);
  assert.match(calendarHtml, /function canApplyCalendarUpdateAutomatically\(\)/);
  assert.match(calendarHtml, /!document\.body\.classList\.contains\('modal-open'\)/);
  assert.match(calendarHtml, /!appointmentActionInProgress/);
  assert.match(calendarHtml, /autoApply && canApplyCalendarUpdateAutomatically\(\)[\s\S]*?applyCalendarUpdate\(\)/);
});
