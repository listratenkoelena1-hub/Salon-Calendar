"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  appointmentToDashBlock,
  buildCanonicalBlockKey,
  buildDashAppointment,
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
  assert.equal(result.block.durationMinutes, 60);
  assert.equal(
    result.block.canonicalKey,
    buildCanonicalBlockKey({
      date: "2026-10-01",
      start: "10:00",
      end: "11:00",
      dashStaffId: result.block.dashStaffId
    })
  );
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

test("parses created, canceled, and rescheduled Dash appointment notifications", () => {
  const parsed = parseDashNotification({
    title: "New Dash Booking Appointment",
    description: "Sample Client has booked an appointment on 2026-10-03 at 14:15",
    observedLabel: "2 minutes ago"
  });
  assert.equal(parsed.client, "Sample Client");
  assert.equal(parsed.kind, "created");
  assert.equal(parsed.date, "2026-10-03");
  assert.equal(parsed.time, "14:15");
  assert.match(parsed.receiptKey, /^[a-f0-9]{64}$/);
  assert.equal(parseDashNotification({
    title: "Appointment Canceled",
    description: "Sample Client has canceled the appointment on 2026-10-03"
  }).kind, "canceled");
  assert.equal(parseDashNotification({
    title: "Appointment Rescheduled",
    description: "Sample Client has rescheduled the appointment to 2026-10-04"
  }).kind, "rescheduled");
});

test("parses the visible Dash appointment detail page", () => {
  const detail = parseDashAppointmentDetail({
    url: "https://www.partnersdash.com/appointments/view?aid=dash-aid-123",
    clientUrl: "/clients/details?cid=dash-client-789",
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
    dashClientId: "dash-client-789",
    client: "Sample Client",
    date: "2026-09-25",
    start: 39,
    duration: 6,
    service: "Gel Nails Extension",
    staffName: "Cindy",
    sourceUrl: "https://www.partnersdash.com/appointments/view?aid=dash-aid-123",
    dashStatus: "confirmed",
    canceledByClient: false,
    cancellationReason: "",
    previousDate: "",
    previousTime: "",
    rescheduledDate: "",
    rescheduledTime: ""
  });
});

test("parses Dash cancellation and reschedule history from appointment details", () => {
  const detail = parseDashAppointmentDetail({
    url: "https://www.partnersdash.com/appointments/view?aid=dash-state",
    text: [
      "Appointment Details",
      "Search Client",
      "Sample Client",
      "Friday, 25 Sep 2026",
      "10:00 am",
      "Pedicure",
      "1h - Luba",
      "Canceled by Client",
      "Canceled reason: Schedule changed",
      "Rescheduled on Dash Booking: 2026-09-24 09:00 → 2026-09-25 10:00",
      "Dash Booking"
    ].join("\n")
  });

  assert.equal(detail.dashStatus, "canceled");
  assert.equal(detail.canceledByClient, true);
  assert.equal(detail.cancellationReason, "Schedule changed");
  assert.equal(detail.previousDate, "2026-09-24");
  assert.equal(detail.previousTime, "09:00");
  assert.equal(detail.rescheduledDate, "2026-09-25");
  assert.equal(detail.rescheduledTime, "10:00");
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

test("parses the current View Appointment page with linked client and split staff line", () => {
  const detail = parseDashAppointmentDetail({
    url: "https://www.partnersdash.com/appointments/view?aid=current-dash-page",
    clientHint: "Sample Current Client",
    text: [
      "View Appointment",
      "Saturday, 26 Sep 2026",
      "Completed",
      "10:00 am",
      "House Special Spa Pedicure With Shellac",
      "1h -",
      "Lan",
      "Type:",
      "Dash Booking"
    ].join("\n")
  });

  assert.equal(detail.client, "Sample Current Client");
  assert.equal(detail.date, "2026-09-26");
  assert.equal(detail.start, 8);
  assert.equal(detail.duration, 4);
  assert.equal(detail.service, "House Special Spa Pedicure With Shellac");
  assert.equal(detail.staffName, "Lan");
});

test("resolves the local technician and builds a confirmed Dash appointment", () => {
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
  const appointment = buildDashAppointment(detail, localStaff);
  assert.equal(appointment.type, "appointment");
  assert.equal(appointment.source, "dash_booking");
  assert.equal(appointment.staffId, "local-tanya");
  assert.equal(appointment.status, "confirmed");
  assert.equal(appointment.lastEditedBy, "DashBooking");
  assert.equal(appointment.lastAction, "dash_appointment_added");
  assert.equal(appointment.hasClientHistory, false);
  assert.match(getDashRequestDocumentId(detail.dashBookingId), /^dash_[a-f0-9]{40}$/);
});

test("marks a Dash appointment as history-capable when Dash exposes a stable client cid", () => {
  const appointment = buildDashAppointment({
    dashBookingId: "dash-booking-43",
    dashClientId: "dash-client-stable",
    client: "Sample Client",
    date: "2026-10-02",
    start: 12,
    duration: 4,
    service: "Pedicure",
    staffName: "Tanya"
  }, { id: "local-tanya", name: "Tanya" });

  assert.equal(appointment.hasPrivateContact, false);
  assert.equal(appointment.hasClientHistory, true);
  assert.equal(appointment.privacySchemaVersion, 1);
  assert.equal(Object.hasOwn(appointment, "dashClientId"), false);
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
