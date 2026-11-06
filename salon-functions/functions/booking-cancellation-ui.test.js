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

test("all booking entry points contain the same secure management experience", () => {
  const pages = bookingFiles.map(file => fs.readFileSync(file, "utf8"));
  assert.equal(pages[1], pages[0]);
  assert.equal(pages[2], pages[0]);

  const page = pages[0];
  assert.match(page, /Manage \/ Reschedule appointment/);
  assert.match(page, /Keep this appointment and book another/);
  assert.match(page, /rescheduleOnlineBookingAppointment/);
  assert.match(page, /appointmentId: state\.rescheduleAppointmentId/);
  assert.match(page, /sessionToken: state\.appointmentSessionToken/);
  assert.match(page, /Online cancellation is available until 3 hours before the appointment\./);
  assert.match(page, /Cancellation comment \(optional\)/);
  assert.match(page, /maxlength="500"/);
  assert.match(page, /comment: cancellationCommentInput\.value\.trim\(\)/);
  assert.match(page, /Confirmed and pending online appointments can be rescheduled or cancelled until 3 hours/);
  assert.match(page, /Rescheduling keeps the same service and duration/);
  assert.match(page, /To change the service, cancel this appointment and book a new one/);
  assert.match(page, /renderCancellationCompleteMessage\(appointment, includedComment\)/);
  assert.match(page, /Your appointment has been successfully rescheduled/);
  assert.match(page, /Previous appointment:/);
  assert.match(page, /New appointment:/);
  assert.match(page, /We look forward to seeing you/);
});

test("booking preview remains isolated to localhost and Firebase preview channels", () => {
  const page = fs.readFileSync(bookingFiles[0], "utf8");
  assert.match(page, /const isLocalBookingPreview = \["localhost", "127\.0\.0\.1", "::1"\]/);
  assert.match(page, /const isFirebasePreviewChannel = bookingHost\.endsWith\("\.web\.app"\) && bookingHost\.includes\("--"\)/);
  assert.match(page, /if \(APPOINTMENT_PREVIEW_ENABLED\) \{\s+await waitForPreview\(\);/);
});
