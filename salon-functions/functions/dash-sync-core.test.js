"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  appointmentToDashBlock,
  buildDashRequestAppointment,
  findDashRequestConflict,
  getDashRequestDocumentId,
  offWorkToDashBlock,
  parseDashAppointmentDetail,
  parseDashNotification,
  planQueueOperation,
  resolveDashStaff,
  resolveLocalStaffForDashName
} = require("./dash-sync-core");

test("maps calendar aliases to the exact Dash staff identity", () => {
  const tanya = resolveDashStaff({ id: "staff-t", name: "Татьяна" });
  assert.equal(tanya.ok, true);
  assert.equal(tanya.dashName, "Tanya");
  assert.equal(tanya.dashStaffId, "6ab3f3488ecf50d467bc87d3");

  const anyone = resolveDashStaff({ id: "anyone", name: "Anyone" });
  assert.equal(anyone.ok, true);
  assert.equal(anyone.dashName, "Anystaff Is Okay :)");

  const sadaf = resolveDashStaff({ id: "staff-s", name: "Sadaf" });
  assert.equal(sadaf.ok, false);
  assert.equal(sadaf.reason, "unmapped-staff");
});

test("an explicit mapping overrides the built-in directory", () => {
  const mapped = resolveDashStaff(
    { id: "local-1", name: "Custom" },
    { "local-1": { dashName: "Custom Dash", dashStaffId: "dash-123" } }
  );
  assert.deepEqual(mapped, {
    ok: true,
    dashName: "Custom Dash",
    dashStaffId: "dash-123",
    source: "override"
  });
});

test("builds an appointment block and clips it to Dash business hours", () => {
  const result = appointmentToDashBlock({
    id: "appt-1",
    date: "2026-10-01",
    staffId: "staff-c",
    start: 6,
    duration: 6,
    canceled: false,
    noShow: false
  }, { id: "staff-c", name: "Cindy" });

  assert.equal(result.ok, true);
  assert.equal(result.block.start, "10:00");
  assert.equal(result.block.end, "11:00");
  assert.equal(result.block.description, "Rose Calendar | appt:appt-1");
  assert.match(result.block.fingerprint, /^[a-f0-9]{64}$/);
});

test("does not block canceled, pending, Dash-origin, or out-of-hours appointments", () => {
  const staff = { id: "staff-c", name: "Cindy" };
  const base = {
    id: "appt-2",
    date: "2026-10-01",
    staffId: staff.id,
    start: 8,
    duration: 4
  };
  assert.equal(appointmentToDashBlock({ ...base, canceled: true }, staff).reason, "inactive-appointment");
  assert.equal(appointmentToDashBlock({ ...base, type: "online_booking_request", status: "request" }, staff).reason, "pending-online-request");
  assert.equal(appointmentToDashBlock({ ...base, source: "dash_booking" }, staff).reason, "dash-origin");
  assert.equal(appointmentToDashBlock({ ...base, start: 48 }, staff).reason, "outside-dash-hours");
  assert.equal(appointmentToDashBlock({ ...base, start: -1 }, staff).reason, "unspecified-start");
});

test("maps an all-day off-work record to the Dash 10 AM-8 PM window", () => {
  const result = offWorkToDashBlock({
    id: "off-1",
    date: "2026-10-01",
    staffId: "staff-o",
    allDay: true
  }, { id: "staff-o", name: "Olha" });

  assert.equal(result.ok, true);
  assert.equal(result.block.start, "10:00");
  assert.equal(result.block.end, "20:00");
  assert.equal(result.block.description, "Rose Calendar | off:off-1");
});

test("queue planner is idempotent and requests deletion only for linked blocks", () => {
  const desired = appointmentToDashBlock({
    id: "appt-3",
    date: "2026-10-01",
    staffId: "staff-l",
    start: 8,
    duration: 4
  }, { id: "staff-l", name: "Lan" });

  assert.equal(planQueueOperation({ desiredResult: desired }).action, "upsert");
  assert.equal(planQueueOperation({
    desiredResult: desired,
    existingLink: { fingerprint: desired.block.fingerprint }
  }).action, "noop");
  assert.equal(planQueueOperation({
    desiredResult: { ok: false, reason: "inactive-appointment" },
    existingLink: { dashBlockId: "dash-block-1" }
  }).action, "delete");
  assert.equal(planQueueOperation({
    desiredResult: { ok: false, reason: "inactive-appointment" },
    existingLink: null
  }).action, "noop");
});

test("parses only new Dash appointment notifications", () => {
  const parsed = parseDashNotification({
    title: "New Dash Booking Appointment",
    description: "Sample Client has booked an appointment on 2026-10-03 at 14:15",
    observedLabel: "2 minutes ago"
  });
  assert.equal(parsed.client, "Sample Client");
  assert.equal(parsed.date, "2026-10-03");
  assert.equal(parsed.time, "14:15");
  assert.match(parsed.receiptKey, /^[a-f0-9]{64}$/);
  assert.equal(parseDashNotification({
    title: "Appointment Rescheduled",
    description: "Sample Client has rescheduled"
  }), null);
});

test("parses the visible Dash appointment detail page", () => {
  const detail = parseDashAppointmentDetail({
    url: "https://www.partnersdash.com/appointments/view?aid=dash-aid-123",
    text: [
      "Appointment Details",
      "Search Client",
      "Sample Client",
      "New Client Life time: 10 pts",
      "Friday, 25 Sep 2026",
      "Confirmed",
      "05:45 pm",
      "Gel Nails Extension - $ 75",
      "1h 30min - Cindy",
      "Dash Booking"
    ].join("\n")
  });

  assert.deepEqual(detail, {
    dashBookingId: "dash-aid-123",
    client: "Sample Client",
    date: "2026-09-25",
    start: 39,
    duration: 6,
    service: "Gel Nails Extension",
    staffName: "Cindy",
    sourceUrl: "https://www.partnersdash.com/appointments/view?aid=dash-aid-123"
  });
});

test("parses an exact-hour Dash duration without a zero-minute suffix", () => {
  const detail = parseDashAppointmentDetail({
    url: "https://www.partnersdash.com/appointments/view?aid=dash-hour-only",
    text: [
      "Appointment Details",
      "Search Client",
      "Sample Client",
      "Friday, 25 Sep 2026",
      "10:00 am",
      "Pedicure",
      "1h - Luba",
      "Dash Booking"
    ].join("\n")
  });

  assert.equal(detail.duration, 4);
  assert.equal(detail.staffName, "Luba");
});

test("resolves the local technician and builds a deterministic blue request", () => {
  const localStaff = resolveLocalStaffForDashName([
    { id: "local-tanya", name: "Tatyana" },
    { id: "local-cindy", name: "Cindy" }
  ], "Tanya");
  assert.equal(localStaff.id, "local-tanya");

  const detail = {
    dashBookingId: "dash-booking-42",
    client: "Sample Client",
    date: "2026-10-02",
    start: 12,
    duration: 6,
    service: "Refill",
    staffName: "Tanya"
  };
  const request = buildDashRequestAppointment(detail, localStaff);
  assert.equal(request.type, "dash_booking_request");
  assert.equal(request.source, "dash_booking");
  assert.equal(request.staffId, "local-tanya");
  assert.equal(request.status, "request");
  assert.match(getDashRequestDocumentId(detail.dashBookingId), /^dash_[a-f0-9]{40}$/);
});

test("detects appointment and off-work conflicts for inbound Dash requests", () => {
  const detail = {
    dashBookingId: "dash-1",
    date: "2026-10-02",
    staffId: "staff-1",
    start: 12,
    duration: 4
  };
  assert.equal(findDashRequestConflict({
    detail,
    appointments: [{ id: "local-1", date: detail.date, staffId: detail.staffId, start: 14, duration: 4 }]
  }).reason, "appointment");
  assert.equal(findDashRequestConflict({
    detail,
    offWork: [{ id: "off-1", date: detail.date, staffId: detail.staffId, start: 10, end: 18 }]
  }).reason, "off-work");
  assert.deepEqual(findDashRequestConflict({ detail }), { conflict: false });
});
