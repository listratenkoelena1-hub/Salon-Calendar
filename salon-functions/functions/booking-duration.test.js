"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getBookingDurationDecision,
  getRequestedBookingDurationSlots
} = require("./booking-duration");

const staff = {
  id: "natasha",
  bookingDurations: {
    manicureNoColor: 4,
    pedicureNoColor: 5,
    manicureGelPolish: 6,
    pedicureGelPolish: 7,
    changeColor: 2,
    pedicureChangeColor: 3,
    refillNoDesign: 6,
    extensionsNoDesign: 8,
    eyebrowWax: 2,
    eyebrowWaxTinting: 3,
    eyelashExtensions: 8,
    refillLashes: 6
  }
};

function duration(serviceDetails, requestedGroups = ["manicure", "pedicure"]) {
  return getRequestedBookingDurationSlots({ serviceDetails, requestedGroups }, staff);
}

test("uses the exact change-color duration instead of a full pedicure", () => {
  assert.equal(duration("Toe color change", ["pedicure"]), 3);
  assert.equal(duration("pedi color change", ["pedicure"]), 3);
  assert.equal(duration("toes", ["pedicure"]), 3);
});

test("recognizes short and Russian service descriptions for staff duration", () => {
  assert.equal(duration("P", ["pedicure"]), 5);
  assert.equal(duration("M", ["manicure"]), 4);
  assert.equal(duration("F", ["manicure"]), 6);
  assert.equal(duration("R", ["manicure"]), 6);
  assert.equal(duration("педикюр гель-лак", ["pedicure"]), 7);
  assert.equal(duration("маникюр гель-лак", ["manicure"]), 6);
});

test("handles design once and never treats no design as an add-on", () => {
  assert.equal(duration("P+M design"), 5 + 4 + 1);
  assert.equal(duration("PM no design"), 5 + 4);
});

test("keeps a one-nail extension as a small add-on", () => {
  assert.equal(duration("One nail extension", ["manicure"]), 1);
});

test("uses refill duration for hard gel instead of gel-polish duration", () => {
  const differentDurations = {
    ...staff,
    bookingDurations: {
      ...staff.bookingDurations,
      manicureGelPolish: 10,
      refillNoDesign: 6
    }
  };
  assert.equal(getRequestedBookingDurationSlots({
    serviceDetails: "Hard gel refill",
    requestedGroups: ["manicure"]
  }, differentDurations), 6);
});

test("sums separately recognized hand and foot services from one typed line", () => {
  const decision = getBookingDurationDecision({
    serviceDetails: "Hard gel refill, Pedicure gel polish",
    requestedGroups: ["manicure", "pedicure"]
  }, staff, null);
  assert.equal(decision.standardDuration, 6 + 7);
  assert.equal(decision.duration, 6 + 7);
});

test("history replaces only a generic main service and preserves other add-ons", () => {
  const summary = {
    hands: { key: "hard_gel_refill", label: "Hard gel refill", count: 3, design: null },
    feet: null,
    durationOverrides: {}
  };
  const decision = getBookingDurationDecision({
    serviceDetails: "M cut nails",
    requestedGroups: ["manicure"]
  }, staff, summary);
  assert.equal(decision.inferredFromHistory, true);
  assert.equal(decision.standardDuration, 7);
  assert.equal(decision.duration, 7);
});

test("a personal duration applies only after the service has been resolved", () => {
  const summary = {
    hands: { key: "hard_gel_refill", label: "Hard gel refill", count: 3, design: null },
    feet: null,
    durationOverrides: {
      "natasha|hands:hard_gel_refill": {
        duration: 9,
        sourceAppointmentId: "previous"
      }
    }
  };
  const decision = getBookingDurationDecision({
    serviceDetails: "M",
    requestedGroups: ["manicure"]
  }, staff, summary);
  assert.equal(decision.standardDuration, 6);
  assert.equal(decision.duration, 9);
  assert.equal(decision.personalized, true);
});
