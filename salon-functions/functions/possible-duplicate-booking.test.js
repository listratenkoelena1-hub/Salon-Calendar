"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  appointmentToDuplicateCandidate,
  buildPossibleDuplicateBookingWarning,
  dashReceiptToDuplicateCandidate,
  findPossibleDuplicateBookings
} = require("./possible-duplicate-booking");

const incoming = {
  id: "new-online",
  source: "online_booking",
  client: "Joanne Page",
  date: "2026-11-27",
  start: 23,
  note: "Manicure Shellac"
};

test("finds close Online and Dash bookings with the same or a similar client name", () => {
  const matches = findPossibleDuplicateBookings(incoming, [
    appointmentToDuplicateCandidate({
      id: "online-old",
      source: "online_booking",
      client: "joanne page",
      date: "2026-11-29",
      start: 24,
      note: "Gel manicure",
      status: "request"
    }),
    dashReceiptToDuplicateCandidate({
      id: "dash-old",
      status: "alerted",
      detail: {
        dashBookingId: "dash-1",
        client: "Joane Page",
        date: "2026-11-30",
        start: 20,
        service: "Hard Gel Manicure"
      }
    })
  ]);

  assert.deepEqual(matches.map(item => item.id), ["online-old", "dash-old"]);
});

test("does not warn for another service family, distant date, canceled booking, or the same id", () => {
  const matches = findPossibleDuplicateBookings(incoming, [
    { id: "feet", source: "dash_booking", client: "Joanne Page", date: "2026-11-28", start: 20, service: "Pedicure" },
    { id: "distant", source: "online_booking", client: "Joanne Page", date: "2026-12-20", start: 20, note: "Manicure" },
    { id: "canceled", source: "online_booking", client: "Joanne Page", date: "2026-11-28", start: 20, note: "Manicure", canceled: true },
    { id: "new-online", source: "online_booking", client: "Joanne Page", date: "2026-11-28", start: 20, note: "Manicure" }
  ]);
  assert.deepEqual(matches, []);
});

test("uses the approved short warning text", () => {
  assert.equal(buildPossibleDuplicateBookingWarning([{
    source: "online_booking",
    date: "2026-11-27",
    start: 23
  }]), [
    "⚠️ POSSIBLE DUPLICATE BOOKING",
    "A client with the same or a similar name may already have a similar appointment on Friday, November 27 at 1:45 PM through Online Booking."
  ].join("\n"));
  assert.equal(buildPossibleDuplicateBookingWarning([{}, {}]), [
    "⚠️ POSSIBLE DUPLICATE BOOKING",
    "Similar appointments were found for a client with the same or a similar name."
  ].join("\n"));
  assert.doesNotMatch(buildPossibleDuplicateBookingWarning([{}, {}]), /Please/i);
});
