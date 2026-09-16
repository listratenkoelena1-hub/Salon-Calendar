"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { runApply, verifyMigratedAppointment } = require("./client-history-backfill-cli");
const { summarizeBackfillAppointments } = require("./client-history-backfill-core");

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("This test may only run against the Firestore emulator.");
}

const projectId = "demo-booking-client-backfill";
const environment = {
  ...process.env,
  BOOKING_BACKFILL_ENABLE_WRITES: "YES",
  CLIENT_LOOKUP_PEPPER: "synthetic-emulator-secret"
};
const options = {
  projectId,
  apply: true,
  confirmProject: projectId,
  rulesVerified: true,
  backendVerified: true,
  limit: 1
};

function appointment({ name, phone, source, status = "confirmed" }) {
  return {
    client: name,
    phone,
    date: "2026-09-15",
    start: 40,
    staffId: "tech-one",
    note: "hard gel refill",
    duration: 8,
    bookingStandardDuration: 6,
    ...(source ? { source } : {}),
    status,
    lastAction: status === "declined" ? "online_request_declined" : "online_request_confirmed"
  };
}

test("server migration is repeatable in the emulator and leaves old phone-free records untouched", async () => {
  if (!admin.apps.length) admin.initializeApp({ projectId });
  const db = admin.firestore();
  try {
    await Promise.all([
      db.collection("appointments").doc("a-naomi-online").set(appointment({
        name: "Naomi", phone: "7805550123", source: "online_booking"
      })),
      db.collection("appointments").doc("b-deborah-online-declined").set(appointment({
        name: "Deborah", phone: "7805550123", source: "online_booking", status: "declined"
      })),
      db.collection("appointments").doc("c-naomi-online").set(appointment({
        name: "Naomi", phone: "7805550123", source: "online_booking"
      })),
      db.collection("appointments").doc("d-manual").set(appointment({
        name: "Barbara", phone: "7805550456", source: null
      })),
      db.collection("appointments").doc("z-no-phone").set({
        client: "Synthetic Client", date: "2026-09-15", note: "pedicure", duration: 4
      })
    ]);
    const before = await db.collection("appointments").get();
    assert.deepEqual(summarizeBackfillAppointments(
      before.docs.map(snapshot => snapshot.data())
    ), {
      total: 5, booking: 3, candidate: 4, candidateBooking: 3,
      candidateOther: 1, withoutPhone: 1, invalidPhone: 0, missingName: 0,
      alreadyVersioned: 0, inconsistentPublicPhone: 0,
      distinctCandidatePhones: 2, distinctCandidatePhoneNames: 3
    });

    const first = await runApply(options, { environment });
    assert.equal(first.migrated, 1);
    assert.equal(first.verified, 1);
    const second = await runApply({ ...options, limit: null }, { environment });
    assert.equal(second.migrated, 3);
    assert.equal(second.verified, 3);
    const third = await runApply({ ...options, limit: null }, { environment });
    assert.equal(third.candidatesSelected, 0);
    assert.equal(third.migrated, 0);

    const [naomi, deborah, naomiAgain, manual, old] = await db.getAll(...[
      "a-naomi-online", "b-deborah-online-declined", "c-naomi-online",
      "d-manual", "z-no-phone"
    ].map(id => db.collection("appointments").doc(id)));
    for (const snapshot of [naomi, deborah, naomiAgain, manual]) {
      assert.equal(snapshot.data().phone, undefined);
      assert.equal(snapshot.data().privacySchemaVersion, 1);
      await verifyMigratedAppointment(db, snapshot.id);
    }
    assert.equal(old.data().privacySchemaVersion, undefined);
    assert.equal(old.data().note, "pedicure");
    assert.equal(naomi.data().source, "online_booking");
    assert.equal(deborah.data().status, "declined");
    assert.equal(naomi.data().duration, 8);
    const [naomiPrivate, deborahPrivate, naomiAgainPrivate, manualPrivate] = await db.getAll(...[
      "a-naomi-online", "b-deborah-online-declined", "c-naomi-online", "d-manual"
    ].map(id => db.collection("appointmentPrivate").doc(id)));
    assert.equal(naomiPrivate.data().clientId, deborahPrivate.data().clientId);
    assert.equal(naomiPrivate.data().clientId, naomiAgainPrivate.data().clientId);
    assert.notEqual(naomiPrivate.data().clientId, manualPrivate.data().clientId);
    assert.notEqual(naomiPrivate.data().clientProfileId, deborahPrivate.data().clientProfileId);
    assert.equal(naomiPrivate.data().clientProfileId, naomiAgainPrivate.data().clientProfileId);
    assert.equal((await db.collection("clientPhoneIndex").get()).size, 2);
    assert.equal((await db.collection("clientProfiles").get()).size, 3);
    assert.equal((await db.collection("clientAppointmentHistory").get()).size, 4);
    assert.equal((await db.collection("clientAppointmentHistory")
      .doc("b-deborah-online-declined").get()).data().historyEligible, false);
  } finally {
    await admin.app().delete();
  }
});
