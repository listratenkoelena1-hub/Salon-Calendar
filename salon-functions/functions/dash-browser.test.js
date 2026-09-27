"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAppointmentsDateUrl,
  buildCreateBlockUrl,
  buildEditBlockUrl,
  buildNotificationCandidates,
  dashNavigationReached,
  formatSafeDashPageState,
  getDashBlockIdFromUrl,
  getDashStaffIdFromUrl,
  getStaticNotificationTime,
  isRetryableNavigationError,
  toTwelveHour
} = require("./dash-browser");

test("builds the visible Dash Block Time routes with encoded values", () => {
  const block = {
    date: "2026-10-01",
    start: "13:30",
    end: "15:00",
    dashStaffId: "dash-staff-1",
    dashBlockId: "dash-block-1",
    description: "Rose Calendar | appt:abc 123"
  };
  const createUrl = new URL(buildCreateBlockUrl(block));
  assert.equal(createUrl.pathname, "/appointments/block-time");
  assert.equal(createUrl.searchParams.get("createNew"), "true");
  assert.equal(createUrl.searchParams.get("staff"), "dash-staff-1");

  const editUrl = new URL(buildEditBlockUrl(block));
  assert.equal(editUrl.searchParams.get("createNew"), "false");
  assert.equal(editUrl.searchParams.get("aid"), "dash-block-1");
  assert.equal(editUrl.searchParams.get("description"), block.description);
  assert.equal(getDashBlockIdFromUrl(editUrl.toString()), "dash-block-1");
  assert.equal(getDashStaffIdFromUrl(editUrl.toString()), "dash-staff-1");

  const calendarUrl = new URL(buildAppointmentsDateUrl(block.date));
  assert.equal(calendarUrl.pathname, "/appointments");
  assert.equal(calendarUrl.searchParams.get("date"), block.date);
});

test("formats Dash select labels and stable notification clock text", () => {
  assert.equal(toTwelveHour("00:15"), "12:15 am");
  assert.equal(toTwelveHour("13:30"), "01:30 pm");
  assert.equal(toTwelveHour("20:00"), "08:00 pm");
  assert.equal(getStaticNotificationTime("13 hours ago at 08:26 pm"), "08:26 pm");
});

test("keeps identical same-minute notifications as separate candidates", () => {
  const summaries = [0, 1].map(index => ({
    index,
    title: "New Dash Booking Appointment",
    description: "Naomi has booked an appointment on 2026-10-02 at 14:15",
    observedLabel: "a few seconds ago at 08:26 pm"
  }));
  const candidates = buildNotificationCandidates(summaries);

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].fingerprint, candidates[1].fingerprint);
  assert.equal(candidates[0].occurrence, 0);
  assert.equal(candidates[1].occurrence, 1);
  assert.notEqual(candidates[0].notificationKey, candidates[1].notificationKey);
});

test("formats login diagnostics without page text or customer data", () => {
  const diagnostic = formatSafeDashPageState({
    host: "www.partnersdash.com",
    path: "/appointments",
    readyState: "complete",
    hasEmailField: false,
    hasPasswordField: false,
    hasDashboardMarker: true,
    iframeCount: 0,
    challengeDetected: false,
    customerName: "Must never be included"
  });

  assert.equal(
    diagnostic,
    "host=www.partnersdash.com;path=/appointments;ready=complete;email=0;password=0;dashboard=1;iframes=0;challenge=0"
  );
  assert.doesNotMatch(diagnostic, /customer|must never/i);
});

test("retries only transient Chromium navigation failures", () => {
  assert.equal(isRetryableNavigationError(new Error("Attempted to use detached Frame 'abc'")), true);
  assert.equal(isRetryableNavigationError(new Error("net::ERR_ABORTED at https://example.com")), true);
  assert.equal(isRetryableNavigationError(new Error("Navigation timeout exceeded")), false);
  assert.equal(
    dashNavigationReached(
      "https://www.partnersdash.com/appointments?date=2026-09-26",
      "https://www.partnersdash.com/appointments?date=2026-09-26"
    ),
    true
  );
  assert.equal(
    dashNavigationReached(
      "https://www.partnersdash.com/appointments?date=2026-09-27",
      "https://www.partnersdash.com/appointments?date=2026-09-26"
    ),
    false
  );
});
