"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const admin = require("firebase-admin");
const { initializeApp, deleteApp } = require("firebase/app");
const {
  initializeAuth,
  inMemoryPersistence,
  connectAuthEmulator,
  signInWithEmailAndPassword
} = require("firebase/auth");
const { getFirestore, connectFirestoreEmulator, doc, getDoc } = require("firebase/firestore");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");
const { runApply } = require("./client-history-backfill-cli");
const { buildSessionTokenHash } = require("./booking-management");

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("Integration tests require local Firestore and Auth emulators.");
}

const projectId = "demo-booking-client-backfill";
const pepper = "synthetic-emulator-secret";
const phone = "7805550123";
const appointmentId = "legacy-online-future-one";
const pastId = "legacy-online-past-one";
const noPhoneId = "legacy-no-phone-one";

function createClient(name) {
  const app = initializeApp({
    apiKey: "synthetic-demo-key",
    projectId,
    appId: `synthetic-${name}`,
    authDomain: `${projectId}.firebaseapp.com`
  }, name);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  const firestore = getFirestore(app);
  connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  const functions = getFunctions(app, "us-central1");
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  return { app, auth, firestore, functions };
}

async function signIn(client, email) {
  await signInWithEmailAndPassword(client.auth, email, "synthetic-password-123");
}

test("two real emulator managers get private contacts while staff sees only public appointments", async () => {
  if (!admin.apps.length) admin.initializeApp({ projectId });
  const db = admin.firestore();
  const clients = ["manager-one", "manager-two", "staff-one"].map(createClient);
  const booking = createClient("booking-public");
  try {
    await Promise.all([
      admin.auth().createUser({ uid: "manager-one", email: "manager-one@example.test",
        password: "synthetic-password-123" }),
      admin.auth().createUser({ uid: "manager-two", email: "manager-two@example.test",
        password: "synthetic-password-123" }),
      admin.auth().createUser({ uid: "staff-one", email: "staff-one@example.test",
        password: "synthetic-password-123" })
    ]);
    await Promise.all([
      db.collection("users").doc("manager-one").set({ role: "manager" }),
      db.collection("users").doc("manager-two").set({ role: "manager" }),
      db.collection("users").doc("staff-one").set({ role: "staff", staffId: "tech-one" }),
      db.collection("staff").doc("tech-one").set({ name: "Synthetic Tech", active: true }),
      db.collection("appointments").doc(appointmentId).set({
        date: "2026-10-15", start: 40, duration: 8, staffId: "tech-one",
        client: "Naomi", note: "hard gel refill", phone,
        phoneLookup: phone, source: "online_booking", status: "confirmed"
      }),
      db.collection("appointments").doc(pastId).set({
        date: "2026-09-01", start: 40, duration: 8, staffId: "tech-one",
        client: "Naomi", note: "hard gel refill", phone,
        phoneLookup: phone, source: "online_booking", status: "confirmed"
      }),
      db.collection("appointments").doc(noPhoneId).set({
        date: "2026-09-01", start: 40, duration: 4, staffId: "tech-one",
        client: "Synthetic Client", note: "pedicure"
      }),
      db.collection("activityLog").doc("staff-visible-log").set({
        createdAt: new Date("2026-10-15T18:00:00Z"),
        logDate: "2026-10-15",
        actorLabel: "Manager",
        actorKey: "manager",
        staffId: "tech-one",
        staffName: "Synthetic Tech",
        eventType: "updated_app",
        entityType: "appointment",
        entityId: appointmentId,
        client: "Naomi",
        phone,
        service: "hard gel refill",
        details: `Naomi; changed: phone ${phone} -> -; duration 2 hr`,
        source: "online_booking"
      })
    ]);
    const migrated = await runApply({
      projectId, apply: true, confirmProject: projectId,
      rulesVerified: true, backendVerified: true, limit: null
    }, { environment: {
      ...process.env, BOOKING_BACKFILL_ENABLE_WRITES: "YES", CLIENT_LOOKUP_PEPPER: pepper
    } });
    assert.equal(migrated.migrated, 2);
    const privateBefore = (await db.collection("appointmentPrivate").doc(appointmentId).get()).data();
    assert.ok(privateBefore.clientId);

    await Promise.all([
      signIn(clients[0], "manager-one@example.test"),
      signIn(clients[1], "manager-two@example.test"),
      signIn(clients[2], "staff-one@example.test")
    ]);
    for (const client of clients) {
      const publicAppointment = await getDoc(doc(client.firestore, "appointments", appointmentId));
      const oldAppointment = await getDoc(doc(client.firestore, "appointments", noPhoneId));
      assert.equal(publicAppointment.exists(), true);
      assert.equal(oldAppointment.exists(), true);
      assert.equal(publicAppointment.data().phone, undefined);
      assert.equal(publicAppointment.data().clientId, undefined);
      await assert.rejects(getDoc(doc(client.firestore, "appointmentPrivate", appointmentId)));
      await assert.rejects(getDoc(doc(client.firestore, "clientLookup", privateBefore.clientId)));
    }

    for (const manager of clients.slice(0, 2)) {
      const contact = (await httpsCallable(manager.functions, "managerGetAppointmentContact")({
        appointmentId
      })).data;
      assert.equal(contact.ok, true);
      assert.equal(contact.phone, phone);
      assert.equal(contact.hasPrivateContact, true);
      const lookup = (await httpsCallable(manager.functions, "managerLookupClientByPhone")({
        phone, includeAppointments: true
      })).data;
      assert.equal(lookup.found, true);
      assert.equal(lookup.hasPrivateClient, true);
      assert.equal(lookup.profiles.length, 1);
      assert.equal(lookup.appointments.length, 2);
      const history = (await httpsCallable(manager.functions, "managerGetClientHistory")({
        appointmentId
      })).data;
      assert.equal(history.available, true);
      assert.equal(history.phone, phone);
      assert.equal(history.past.length, 1);
      assert.equal(history.past[0].id, pastId);
      await assert.rejects(httpsCallable(manager.functions, "managerLookupClientByPhone")({
        phone: "780"
      }));
    }
    await assert.rejects(httpsCallable(clients[2].functions, "managerGetAppointmentContact")({
      appointmentId
    }), /Manager access is required/);
    await assert.rejects(httpsCallable(clients[2].functions, "managerLookupClientByPhone")({
      phone, includeAppointments: true
    }), /Manager access is required/);
    await assert.rejects(httpsCallable(clients[2].functions, "managerGetClientHistory")({
      appointmentId
    }), /Manager access is required/);

    await assert.rejects(getDoc(doc(clients[2].firestore,
      "activityLog", "staff-visible-log")));
    const staffLog = (await httpsCallable(clients[2].functions, "getStaffActivityLog")({
      logDate: "2026-10-15"
    })).data;
    assert.equal(staffLog.ok, true);
    assert.equal(staffLog.truncated, false);
    assert.equal(staffLog.entries.length, 1);
    assert.equal(staffLog.entries[0].id, "staff-visible-log");
    assert.equal(staffLog.entries[0].phone, undefined);
    assert.equal(staffLog.entries[0].email, undefined);
    assert.equal(staffLog.entries[0].details.includes(phone), false);
    assert.match(staffLog.entries[0].details, /phone \[hidden\]/);
    assert.equal(typeof staffLog.entries[0].createdAtMillis, "number");
    const managerLogContacts = (await httpsCallable(clients[0].functions,
      "managerGetActivityLogContacts")({ logDate: "2026-10-15" })).data;
    assert.equal(managerLogContacts.contacts.length, 1);
    assert.equal(managerLogContacts.contacts[0].phone, phone);
    await assert.rejects(httpsCallable(booking.functions, "getStaffActivityLog")({
      logDate: "2026-10-15"
    }), /You must be signed in/);

    const newAppointmentId = "synthetic-new-manual-one";
    const mutation = (await httpsCallable(clients[0].functions, "mutateAppointment")({
      mode: "create", appointmentId: newAppointmentId,
      mutationId: "synthetic-mutation-one",
      appointment: {
        date: "2026-11-18", start: 40, duration: 8, staffId: "tech-one",
        client: "Naomi", phone, note: "hard gel refill"
      }
    })).data;
    assert.equal(mutation.ok, true);
    assert.equal(mutation.hasPrivateContact, true);
    const [newPublic, newPrivate] = await db.getAll(
      db.collection("appointments").doc(newAppointmentId),
      db.collection("appointmentPrivate").doc(newAppointmentId)
    );
    assert.equal(newPublic.data().phone, undefined);
    assert.equal(newPrivate.data().clientId, privateBefore.clientId);
    assert.equal(newPrivate.data().clientProfileId, privateBefore.clientProfileId);
    const staffPublic = await getDoc(doc(clients[2].firestore, "appointments", newAppointmentId));
    assert.equal(staffPublic.exists(), true);
    assert.equal(staffPublic.data().phone, undefined);

    const requestId = "synthetic-online-request-one";
    const publicBookingResult = (await httpsCallable(booking.functions, "createOnlineBookingRequest")({
      requestId,
      client: "Naomi",
      phone,
      date: "2026-11-20",
      start: 24,
      staffId: "tech-one",
      serviceDetails: "hard gel refill",
      selectedServices: [],
      consentAccepted: true,
      consentVersion: "privacy-consent-v3-2026-09-06"
    })).data;
    assert.equal(publicBookingResult.ok, true);
    assert.equal(publicBookingResult.duplicate, false);
    assert.ok(publicBookingResult.appointmentId);
    const duplicateBookingResult = (await httpsCallable(booking.functions,
      "createOnlineBookingRequest")({
      requestId,
      client: "Naomi",
      phone,
      date: "2026-11-20",
      start: 24,
      staffId: "tech-one",
      serviceDetails: "hard gel refill",
      consentAccepted: true,
      consentVersion: "privacy-consent-v3-2026-09-06"
    })).data;
    assert.equal(duplicateBookingResult.duplicate, true);
    assert.equal(duplicateBookingResult.appointmentId, publicBookingResult.appointmentId);
    const onlineRef = db.collection("appointments").doc(publicBookingResult.appointmentId);
    const onlinePrivateRef = db.collection("appointmentPrivate").doc(publicBookingResult.appointmentId);
    const onlineHistoryRef = db.collection("clientAppointmentHistory")
      .doc(publicBookingResult.appointmentId);
    const [pendingOnline, pendingPrivate, pendingHistory] = await db.getAll(
      onlineRef, onlinePrivateRef, onlineHistoryRef
    );
    assert.equal(pendingOnline.data().phone, undefined);
    assert.equal(pendingOnline.data().source, "online_booking");
    assert.equal(pendingOnline.data().status, "request");
    assert.equal(pendingPrivate.data().clientId, privateBefore.clientId);
    assert.equal(pendingPrivate.data().clientProfileId, privateBefore.clientProfileId);
    assert.equal(pendingHistory.data().historyEligible, false);
    await assert.rejects(getDoc(doc(booking.firestore, "appointments",
      publicBookingResult.appointmentId)));

    // No real customer delivery is exercised: there is no email, and SMS is
    // explicitly disabled on this synthetic request before confirmation.
    await onlineRef.set({ smsConsent: false }, { merge: true });
    const confirmForm = (await onlineRef.get()).data();
    const confirmed = (await httpsCallable(clients[0].functions, "mutateAppointment")({
      mode: "confirm",
      appointmentId: publicBookingResult.appointmentId,
      mutationId: "synthetic-confirm-one",
      expectedRevision: confirmForm.revision,
      appointment: {
        date: confirmForm.date,
        start: confirmForm.start,
        duration: confirmForm.duration + 2,
        staffId: confirmForm.staffId,
        client: confirmForm.client,
        note: confirmForm.note,
        phone
      }
    })).data;
    assert.equal(confirmed.ok, true);
    const [confirmedOnline, confirmedPrivate, confirmedHistory] = await db.getAll(
      onlineRef, onlinePrivateRef, onlineHistoryRef
    );
    assert.equal(confirmedOnline.data().source, "online_booking");
    assert.equal(confirmedOnline.data().status, "confirmed");
    assert.equal(confirmedOnline.data().duration, confirmForm.duration + 2);
    assert.equal(confirmedOnline.data().phone, undefined);
    assert.equal(confirmedPrivate.data().clientId, privateBefore.clientId);
    assert.equal(confirmedHistory.data().source, "online_booking");
    assert.equal(confirmedHistory.data().duration, confirmForm.duration + 2);
    assert.equal(confirmedHistory.data().historyEligible, true);

    const cancellationChallengeId = "synthetic-cancel-challenge";
    const cancellationSessionToken = "synthetic-cancel-session-token-1234567890";
    await db.collection("onlineBookingVerificationChallenges")
      .doc(cancellationChallengeId)
      .set({
        status: "verified",
        sessionTokenHash: buildSessionTokenHash(cancellationSessionToken),
        sessionExpiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 20 * 60 * 1000),
        phoneDigits: phone,
        clientName: "naomi",
        clientId: confirmedPrivate.data().clientId,
        clientProfileId: confirmedPrivate.data().clientProfileId,
        managedAppointmentIds: []
      });
    const cancellation = (await httpsCallable(
      booking.functions,
      "cancelOnlineBookingAppointment"
    )({
      challengeId: cancellationChallengeId,
      sessionToken: cancellationSessionToken,
      appointmentId: publicBookingResult.appointmentId,
      comment: "Family emergency"
    })).data;
    assert.equal(cancellation.ok, true);
    const [cancelledOnline, cancelledHistory] = await db.getAll(onlineRef, onlineHistoryRef);
    assert.equal(cancelledOnline.data().canceled, true);
    assert.equal(cancelledOnline.data().lastMutationMode, "online_client_cancel");
    assert.equal(cancelledOnline.data().clientCancellationComment, "Family emergency");
    assert.match(cancelledOnline.data().cancelComment, /Client comment: Family emergency/);
    assert.equal(cancelledHistory.data().canceled, true);
    const cancellationLogs = await db.collection("activityLog")
      .where("entityId", "==", publicBookingResult.appointmentId)
      .where("eventType", "==", "canceled")
      .get();
    assert.equal(cancellationLogs.size, 1);
    assert.match(cancellationLogs.docs[0].data().details, /Client comment: Family emergency/);
    const cancellationMessages = await db.collection("staffMessages")
      .where("messageGroupId", "==", `online-booking-cancel-${publicBookingResult.appointmentId}`)
      .get();
    assert.equal(cancellationMessages.size, 1);
    assert.equal(
      cancellationMessages.docs[0].data().body,
      "Online appointment for Naomi with Synthetic Tech was cancelled by the client.\n" +
        "Client comment: Family emergency"
    );
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal((await db.collection("EmailQueue").get()).size, 0);
    assert.equal((await db.collection("SmsQueue").get()).size, 0);
  } finally {
    await Promise.all([...clients, booking].map(client => deleteApp(client.app)));
    await admin.app().delete();
  }
});
