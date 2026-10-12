const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "..", "salon-calendar", "index.html"), "utf8");

test("new staff requires a valid email before staff data is written", () => {
  assert.match(html, /id="newStaffEmail"[^>]*type="email"[^>]*required/);
  assert.match(html, /id="newStaffEmailError"[^>]*>Please enter a valid email address\./);
  const addStaff = html.match(/window\.addStaff = async \(\) => \{[\s\S]*?window\.updateStaffColor/)[0];
  assert.ok(addStaff.indexOf("newStaffEmail.checkValidity()") < addStaff.indexOf("await setDoc(docRef"));
  assert.ok(addStaff.indexOf("await ensureAuthUser") < addStaff.indexOf("await setDoc(docRef"));
  assert.match(addStaff, /availableForAnyone:[\s\S]*checked : true/);
  assert.match(addStaff, /bookingEnabled:[\s\S]*checked : true/);
});

test("password reset delivery failure does not leave staff creation half-finished", () => {
  const ensureAuth = html.match(/async function ensureAuthUser\([\s\S]*?\n\}/)[0];
  assert.match(ensureAuth, /catch \(resetError\)/);
  assert.match(ensureAuth, /passwordResetSent/);
  const resetCatch = ensureAuth.match(/catch \(resetError\) \{[\s\S]*?\n      \}/)[0];
  assert.doesNotMatch(resetCatch, /return false/);
});

test("new staff defaults include manicure and pedicure", () => {
  assert.match(html, /data-new-staff-service value="manicure" checked/);
  assert.match(html, /data-new-staff-service value="pedicure" checked/);
});

test("first-login onboarding is localized and has explicit actions without an X", () => {
  const modal = html.match(/<div id="staffOnboardingModal"[\s\S]*?<div id="staffNotificationsModal"/)[0];
  assert.match(modal, /staffOnboardingLangEnBtn/);
  assert.match(modal, /staffOnboardingLangUkBtn/);
  assert.match(modal, /staffOnboardingLangRuBtn/);
  assert.match(modal, /allowStaffOnboardingNotifications/);
  assert.match(modal, /snoozeStaffOnboarding/);
  assert.match(modal, /completeStaffOnboarding/);
  assert.doesNotMatch(modal, /aria-label="Close"|onclick="[^"\n]*closeStaffOnboarding/);
  assert.match(html, /Добро пожаловать в команду Rose’s Nails Londonderry/);
  assert.match(html, /Ласкаво просимо до команди Rose’s Nails Londonderry/);
  assert.match(html, /Сообщения хранятся 60 дней/);
  assert.match(html, /закрепите его свайпом вправо/);
});

test("legacy Messages permission guide is no longer opened automatically", () => {
  const initializer = html.match(/async function initializeCalendarPushForUser\(\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(initializer, /openPushPermissionModal|shouldAutoShowPushPrompt/);
});
