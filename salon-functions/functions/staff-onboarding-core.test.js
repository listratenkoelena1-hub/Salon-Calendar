const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STAFF_ONBOARDING_VERSION,
  buildStaffWelcomeEmail
} = require("./staff-onboarding-core");

test("welcome email explains password creation without exposing a temporary password", () => {
  const email = buildStaffWelcomeEmail({
    staffName: "Olena",
    email: "OLENA@example.com",
    calendarUrl: "https://calendar.example"
  });

  assert.equal(STAFF_ONBOARDING_VERSION, "staff-onboarding-v1");
  assert.match(email.subject, /Welcome/);
  assert.match(email.text, /Olena/);
  assert.match(email.text, /olena@example\.com/);
  assert.match(email.text, /Forgot password\?/);
  assert.match(email.text, /Spam, Junk/);
  assert.doesNotMatch(email.text, /Temp1234/i);
});

test("welcome email escapes staff-controlled HTML", () => {
  const email = buildStaffWelcomeEmail({
    staffName: "<Staff>",
    email: "staff@example.com",
    calendarUrl: "https://calendar.example/?a=1&b=2"
  });

  assert.match(email.html, /&lt;Staff&gt;/);
  assert.match(email.html, /a=1&amp;b=2/);
  assert.doesNotMatch(email.html, /<Staff>/);
});
