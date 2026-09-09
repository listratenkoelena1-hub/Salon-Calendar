"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyNoShowWarning,
  buildNameGrams,
  getAppointmentStatus,
  getFeetPreference,
  getHandsPreference,
  getNameMatch,
  normalizeClientName,
  normalizePhone,
  rankNameCandidates,
  splitClientHistory,
  stripPrivateContactFields,
  stripNoShowWarning,
  summarizeClientHistory
} = require("./client-lookup-core");

test("removes every private contact field from public projections", () => {
  assert.deepEqual(stripPrivateContactFields({
    client: "Darlene",
    note: "Manicure",
    phone: "7805550123",
    phoneDisplay: "(780) 555-0123",
    phoneLast4: "0123",
    contactPhone: "7805550123",
    email: "private@example.com",
    clientId: "client-id",
    profileId: "profile-id",
    phoneNormalized: "+17805550123",
    phoneHash: "hash"
  }), {
    client: "Darlene",
    note: "Manicure"
  });
});

test("normalizes North American and international phone formats", () => {
  assert.equal(normalizePhone("(780) 555-0123"), "+17805550123");
  assert.equal(normalizePhone("+1 780 555 0123"), "+17805550123");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("123"), "");
});

test("normalizes names and keeps short names strict", () => {
  assert.equal(normalizeClientName("  Darlène  "), "darlene");
  assert.deepEqual(getNameMatch("Darlene", "Darlene"), { type: "exact", distance: 0, score: 1 });
  assert.equal(getNameMatch("Li", "Lu"), null);
  assert.equal(getNameMatch("Darlene", "Darlne")?.type, "close");
  assert.equal(getNameMatch("Griselda", "Grizelda")?.type, "close");
  assert.equal(getNameMatch("Barbara", "Deborah"), null);
});

test("ranks exact name before a close spelling", () => {
  const profiles = [
    { id: "close", displayName: "Darlne" },
    { id: "exact", displayName: "Darlene" },
    { id: "other", displayName: "Deborah" }
  ];
  const ranked = rankNameCandidates("Darlene", profiles);
  assert.deepEqual(ranked.map(item => item.profile.id), ["exact", "close"]);
  assert.ok(buildNameGrams("Darlene").includes("dar"));
});

test("recognizes only repeated hands and feet preferences", () => {
  assert.equal(getHandsPreference("Pedi gel polish"), null);
  assert.equal(getHandsPreference("Mani hard gel refill design")?.label, "Hard gel refill");
  assert.equal(getFeetPreference("Pedi regular polish")?.label, "Pedicure regular polish");
  assert.equal(getHandsPreference("Pedi no color + Mani gel polish")?.label, "Gel polish");
  assert.equal(getFeetPreference("Pedi no color + Mani gel polish")?.label, "Pedicure no color");
  assert.equal(getHandsPreference("Pedi: gel polish; Mani: no color")?.label, "No color");
  assert.equal(getFeetPreference("Pedi: gel polish; Mani: no color")?.label, "Pedicure gel polish");

  const summary = summarizeClientHistory([
    { staffId: "natasha", note: "Mani hard gel refill", noShow: true },
    { staffId: "natasha", note: "Mani hard gel refill + Pedi regular polish" },
    { staffId: "natasha", note: "Mani hard gel refill + Pedi regular polish", canceled: true },
    { staffId: "luba", note: "Pedi gel polish", noShow: true },
    { staffId: "luba", note: "Pedi gel polish", status: "pending" }
  ]);

  assert.deepEqual(summary.preferredStaff, { staffId: "natasha", count: 3 });
  assert.equal(summary.hands?.label, "Hard gel refill");
  assert.equal(summary.hands?.count, 3);
  assert.equal(summary.feet?.label, "Pedicure regular polish");
  assert.equal(summary.feet?.count, 2);
  assert.equal(summary.noShowCount, 2);
});

test("pending online requests do not influence preferences", () => {
  const summary = summarizeClientHistory([
    { status: "request", staffId: "elena", note: "mani gel polish" },
    { status: "pending", staffId: "elena", note: "mani gel polish" },
    { status: "requested", staffId: "elena", note: "mani gel polish" },
    { status: "confirmed", staffId: "natasha", note: "mani no color" },
    { status: "confirmed", staffId: "natasha", note: "mani no color" }
  ]);
  assert.equal(summary.preferredStaff, null);
  assert.deepEqual(summary.hands, { key: "no_color", label: "No color", count: 2 });
});

test("historical declinedAt does not label a restored appointment declined", () => {
  assert.equal(getAppointmentStatus({
    status: "restored_after_decline",
    canceled: false,
    declinedAt: { seconds: 1 }
  }), "");
  assert.equal(getAppointmentStatus({ status: "declined", canceled: true }), "Declined");
});

test("adds one editable no-show warning and replaces its count", () => {
  assert.equal(applyNoShowWarning("Manicure", 1), "Manicure");
  assert.equal(applyNoShowWarning("Manicure", 2), "Manicure\nThis customer didn't show up 2 times.");
  assert.equal(
    applyNoShowWarning("Manicure\nThis customer didn't show up 2 times.", 4),
    "Manicure\nThis customer didn't show up 4 times."
  );
  assert.equal(stripNoShowWarning("Manicure\nThis customer didn't show up 4 times."), "Manicure");
});

test("history excludes the current appointment and optional same date", () => {
  const split = splitClientHistory([
    { id: "old", date: "2026-08-01", start: 4 },
    { id: "same", date: "2026-09-08", start: 5 },
    { id: "current", date: "2026-09-10", start: 6 },
    { id: "future", date: "2026-10-01", start: 7 }
  ], {
    today: "2026-09-08",
    currentAppointmentId: "current",
    excludeDate: "2026-09-08"
  });

  assert.deepEqual(split.past.map(item => item.id), ["old"]);
  assert.deepEqual(split.future.map(item => item.id), ["future"]);
});
