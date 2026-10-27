"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);
const functionsSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

test("the chat translation update notice contains the approved English copy", () => {
  assert.match(calendarHtml, /Meet the New Update/);
  assert.match(calendarHtml, /Chat messages can now be translated directly in Messenger/);
  assert.match(calendarHtml, /Communicating with your team is now easier and faster/);
  assert.match(calendarHtml, /releaseNoticeDismissCheckbox/);
  assert.match(calendarHtml, /Don't show again/);
  assert.match(calendarHtml, /closeReleaseNotice\(\)/);
});

test("the update notice can be read in English, Ukrainian, and Russian", () => {
  assert.match(calendarHtml, /setReleaseNoticeLanguage\('en'\)/);
  assert.match(calendarHtml, /setReleaseNoticeLanguage\('uk'\)/);
  assert.match(calendarHtml, /setReleaseNoticeLanguage\('ru'\)/);
  assert.match(calendarHtml, /Знайомтеся з новим оновленням/);
  assert.match(calendarHtml, /Знакомьтесь с новым обновлением/);
});

test("Close snoozes for four hours while dismissal lasts until the notice version changes", () => {
  assert.match(calendarHtml, /neverShowAgain \? 'dismiss' : 'snooze'/);
  assert.match(calendarHtml, /const RELEASE_NOTICE_SNOOZE_MS = 4 \* 60 \* 60 \* 1000/);
  assert.match(calendarHtml, /showReleaseNoticeWhenReady,\s*RELEASE_NOTICE_SNOOZE_MS/);
  assert.match(calendarHtml, /releaseNoticeDismissedVersion === RELEASE_NOTICE_VERSION/);
  assert.match(functionsSource, /action !== "dismiss" && action !== "snooze"/);
  assert.match(functionsSource, /releaseNoticeSnoozedUntil: Timestamp\.fromMillis\(Date\.now\(\) \+ 4 \* 60 \* 60 \* 1000\)/);
  assert.match(functionsSource, /releaseNoticeDismissedVersion: version/);
  assert.match(functionsSource, /region: "us-central1", invoker: "public"/);
  assert.match(calendarHtml, /saveReleaseNoticeLocalState\(action\)/);
  assert.doesNotMatch(calendarHtml, /Update notice state could not be saved:[\s\S]{0,120}showToast/);
});

test("the update Close button is compact and right-aligned", () => {
  assert.match(calendarHtml, /#releaseNoticeModal \.staff-onboarding-actions button \{[\s\S]*?flex: 0 0 auto;[\s\S]*?width: auto;[\s\S]*?min-width: 86px;/);
  assert.match(calendarHtml, /\.staff-onboarding-actions \{[\s\S]*?justify-content: flex-end;/);
});

test("the same release notice version is enforced by the browser and server", () => {
  const browserVersion = calendarHtml.match(/const RELEASE_NOTICE_VERSION = '([^']+)'/)?.[1];
  const serverVersion = functionsSource.match(/const RELEASE_NOTICE_VERSION = "([^"]+)"/)?.[1];
  assert.equal(browserVersion, "chat-translation-v1");
  assert.equal(serverVersion, browserVersion);
});
