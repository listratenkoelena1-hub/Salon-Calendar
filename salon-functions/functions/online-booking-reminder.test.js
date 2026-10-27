"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  MAX_SINGLE_SMS_CHARACTERS,
  buildOnlineBookingReminderBody,
  getMinutesUntilAppointment,
  getReminderDateKeys,
  isOnlineBookingReminderDue
} = require("./online-booking-reminder");

const functionsSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

const now = new Date("2026-10-28T17:30:00.000Z"); // 11:30 AM in Edmonton.
const confirmedOnline = {
  source: "online_booking",
  status: "confirmed",
  date: "2026-10-28",
  start: 26, // 2:30 PM.
  smsConsent: true
};

test("a confirmed online appointment is due exactly three hours before it starts", () => {
  assert.equal(getMinutesUntilAppointment(confirmedOnline, now), 180);
  assert.equal(isOnlineBookingReminderDue(confirmedOnline, { now }), true);
});

test("manual, pending, canceled, no-show, and opted-out appointments never receive reminders", () => {
  const variants = [
    { source: "calendar" },
    { status: "request" },
    { canceled: true },
    { noShow: true },
    { smsConsent: false }
  ];
  for (const patch of variants) {
    assert.equal(isOnlineBookingReminderDue({ ...confirmedOnline, ...patch }, { now }), false);
  }
});

test("the approved reminder stays within one 160-character SMS segment", () => {
  const body = buildOnlineBookingReminderBody({
    date: "2026-10-28",
    start: 26,
    staffName: "Jacqueline",
    salonPhone: "+1 780-406-6767"
  });
  assert.equal(
    body,
    "Hello from Roses Nails! You have an appointment on Oct 28 at 2:30 PM with Jacqueline. If your plans change, please call +1 780-406-6767."
  );
  assert.equal(body.length, 136);
  assert.ok(body.length <= MAX_SINGLE_SMS_CHARACTERS);
});

test("an unusually long technician name is safely shortened to one SMS segment", () => {
  const body = buildOnlineBookingReminderBody({
    date: "2026-09-30",
    start: 48,
    staffName: "A technician name that is deliberately much too long for one normal SMS message",
    salonPhone: "+1 780-406-6767"
  });
  assert.equal(body.length, MAX_SINGLE_SMS_CHARACTERS);
  assert.match(body, /^Hello from Roses Nails!/);
  assert.match(body, /please call \+1 780-406-6767\.$/);
});

test("candidate date keys include the next local date when the three-hour window crosses midnight", () => {
  const lateEvening = new Date("2026-10-29T04:59:00.000Z"); // 10:59 PM in Edmonton.
  assert.deepEqual(getReminderDateKeys(lateEvening), ["2026-10-29"]);
});

test("the scheduled sender is idempotent and stores delivery callbacks without exposing them in the UI", () => {
  assert.match(functionsSource, /exports\.sendOnlineBookingReminders = onSchedule/);
  assert.match(functionsSource, /schedule: "every 15 minutes from 07:00 to 19:00"/);
  assert.match(functionsSource, /timeZone: SALON_TIME_ZONE/);
  assert.match(functionsSource, /doc\(`\$\{ONLINE_BOOKING_REMINDER_QUEUE_PREFIX\}\$\{appointmentId\}`\)/);
  assert.match(functionsSource, /eventType: "appointment_reminder"/);
  assert.match(functionsSource, /exports\.twilioSmsStatus = onRequest/);
  assert.match(functionsSource, /deliveryStatus: messageStatus/);
  assert.match(functionsSource, /messageStatus === "delivered"/);
  assert.match(functionsSource, /\["undelivered", "failed"\]\.includes\(messageStatus\)/);
});
