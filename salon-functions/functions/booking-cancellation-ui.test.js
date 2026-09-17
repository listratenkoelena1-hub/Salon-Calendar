"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const calendarRoot = path.resolve(__dirname, "..", "..", "salon-calendar");
const bookingFiles = [
  path.join(calendarRoot, "online-booking.html"),
  path.join(calendarRoot, "booking-public", "index.html"),
  path.join(calendarRoot, "booking-public", "online-booking.html")
];

test("all booking entry points contain the same cancellation experience", () => {
  const pages = bookingFiles.map(file => fs.readFileSync(file, "utf8"));
  assert.equal(pages[1], pages[0]);
  assert.equal(pages[2], pages[0]);

  const page = pages[0];
  assert.match(page, /Appointments cannot be rescheduled online\./);
  assert.match(page, /Online cancellation is available until 3 hours before the appointment\./);
  assert.match(page, /Cancellation comment \(optional\)/);
  assert.match(page, /maxlength="500"/);
  assert.match(page, /comment: cancellationCommentInput\.value\.trim\(\)/);
  assert.match(page, /Confirmed and pending online appointments can be cancelled until 3 hours/);
});

test("booking preview remains isolated to localhost and Firebase preview channels", () => {
  const page = fs.readFileSync(bookingFiles[0], "utf8");
  assert.match(page, /const isLocalBookingPreview = \["localhost", "127\.0\.0\.1", "::1"\]/);
  assert.match(page, /const isFirebasePreviewChannel = bookingHost\.endsWith\("\.web\.app"\) && bookingHost\.includes\("--"\)/);
  assert.match(page, /if \(APPOINTMENT_PREVIEW_ENABLED\) \{\s+await waitForPreview\(\);/);
});
