"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const admin = require("firebase-admin");
const { initializeApp, deleteApp } = require("firebase/app");
const {
  initializeAuth,
  inMemoryPersistence,
  connectAuthEmulator,
  signInWithEmailAndPassword
} = require("firebase/auth");
const {
  getFirestore,
  connectFirestoreEmulator,
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc
} = require("firebase/firestore");
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require("firebase/functions");

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error("Compatibility tests require local Firestore and Auth emulators.");
}

const mainRoot = process.env.CURRENT_MAIN_ROOT;
if (!mainRoot) throw new Error("CURRENT_MAIN_ROOT must point to the exact main snapshot.");

const projectId = "demo-current-main-new-rules";
const expectedMain = {
  indexHtml: "82fb15d2f0dbc1f0e08b5d858c6f485d565ddbde",
  functionsIndex: "c7093977bb02d9d6fef0d9a2269f3db968ee2252",
  oldRules: "9ab47f3de5adb683c179a072c76d480ce4eee129"
};

function gitBlobSha(content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return crypto.createHash("sha1")
    .update(Buffer.from(`blob ${body.length}\0`))
    .update(body)
    .digest("hex");
}

function readMain(relativePath) {
  return fs.readFileSync(path.join(mainRoot, ...relativePath.split("/")));
}

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

test("exact current main browser operations remain compatible with the client-history rules", async () => {
  const indexHtml = readMain("salon-calendar/index.html");
  assert.equal(gitBlobSha(indexHtml), expectedMain.indexHtml);
  assert.equal(gitBlobSha(readMain("salon-functions/functions/index.js")),
    expectedMain.functionsIndex);
  assert.equal(gitBlobSha(readMain("salon-calendar/firestore.rules")), expectedMain.oldRules);

  const mainSource = indexHtml.toString("utf8");
  assert.match(mainSource,
    /const mutateAppointment = httpsCallable\(functions, ["']mutateAppointment["']\)/);
  assert.match(mainSource, /await mutateAppointment\(payload\)/);
  assert.doesNotMatch(mainSource,
    /(?:addDoc|setDoc|updateDoc|deleteDoc)\([^\n]*(?:collection|doc)\(db,\s*["']appointments["']/);

  if (!admin.apps.length) admin.initializeApp({ projectId });
  const db = admin.firestore();
  const manager = createClient("current-main-manager");
  const staff = createClient("current-main-staff");
  const publicBooking = createClient("current-main-public-booking");

  try {
    await Promise.all([
      admin.auth().createUser({
        uid: "main-manager",
        email: "main-manager@example.test",
        password: "synthetic-password-123"
      }),
      admin.auth().createUser({
        uid: "main-staff",
        email: "main-staff@example.test",
        password: "synthetic-password-123"
      })
    ]);
    await Promise.all([
      db.collection("users").doc("main-manager").set({ role: "manager" }),
      db.collection("users").doc("main-staff").set({ role: "staff", staffId: "tech-main" }),
      db.collection("staff").doc("tech-main").set({
        name: "Synthetic Main Tech",
        active: true,
        color: "#cbb7ff",
        bookingDurations: {}
      }),
      db.collection("appointments").doc("main-legacy-phone").set({
        date: "2026-10-20",
        start: 40,
        duration: 4,
        staffId: "tech-main",
        client: "Legacy Phone Client",
        phone: "7805550101",
        note: "pedicure"
      }),
      db.collection("appointments").doc("main-legacy-no-phone").set({
        date: "2026-10-20",
        start: 48,
        duration: 4,
        staffId: "tech-main",
        client: "Legacy No Phone",
        note: "manicure"
      })
    ]);

    await Promise.all([
      signIn(manager, "main-manager@example.test"),
      signIn(staff, "main-staff@example.test")
    ]);

    for (const client of [manager, staff]) {
      assert.equal((await getDoc(doc(client.firestore,
        "appointments", "main-legacy-phone"))).exists(), true);
      assert.equal((await getDoc(doc(client.firestore,
        "appointments", "main-legacy-no-phone"))).exists(), true);
      await assert.rejects(setDoc(doc(client.firestore,
        "appointments", "forbidden-direct-write"), { client: "No" }));
      await assert.rejects(getDoc(doc(client.firestore,
        "appointmentPrivate", "private-one")));
      await assert.rejects(getDoc(doc(client.firestore,
        "clientLookup", "client-one")));
    }
    await assert.rejects(getDoc(doc(publicBooking.firestore,
      "appointments", "main-legacy-phone")));

    await setDoc(doc(manager.firestore, "OffWork", "main-off-manager"), {
      date: "2026-10-20", staffId: "tech-main", allDay: true
    });
    await setDoc(doc(staff.firestore, "OffWork", "main-off-staff"), {
      date: "2026-10-21", staffId: "tech-main", allDay: true
    });
    assert.equal((await getDoc(doc(staff.firestore,
      "OffWork", "main-off-manager"))).exists(), true);

    await updateDoc(doc(staff.firestore, "staff", "tech-main"), {
      color: "#abc123",
      bookingDurations: { "Manicure Gel Polish": 6 }
    });
    await assert.rejects(updateDoc(doc(staff.firestore, "staff", "tech-main"), {
      name: "Forbidden rename"
    }));
    assert.equal((await getDoc(doc(staff.firestore,
      "users", "main-staff"))).exists(), true);
    await assert.rejects(getDoc(doc(staff.firestore, "users", "main-manager")));
    assert.equal((await getDoc(doc(manager.firestore,
      "users", "main-staff"))).exists(), true);

    await setDoc(doc(manager.firestore, "activityLog", "manager-log"), {
      eventType: "test", phone: "7805550101"
    });
    assert.equal((await getDoc(doc(manager.firestore,
      "activityLog", "manager-log"))).exists(), true);
    await setDoc(doc(staff.firestore, "activityLog", "staff-log-no-phone"), {
      eventType: "test", phone: ""
    });
    await assert.rejects(setDoc(doc(staff.firestore,
      "activityLog", "staff-log-with-phone"), {
      eventType: "test", phone: "7805550101"
    }));
    await assert.rejects(getDoc(doc(staff.firestore,
      "activityLog", "staff-log-no-phone")));

    // Admin SDK server calls bypass Firestore Rules. The exact main snapshot
    // still uses the legacy admin.firestore.FieldValue namespace, which the
    // current Functions emulator no longer exposes. Rules-only mode therefore
    // stops after every browser operation from current main has been checked.
    if (process.env.CURRENT_MAIN_RULES_ONLY === "1") return;

    const manualId = "current-main-callable-create";
    const manualResult = (await httpsCallable(manager.functions, "mutateAppointment")({
      mode: "create",
      appointmentId: manualId,
      mutationId: "current-main-mutation-create",
      appointment: {
        date: "2026-11-10",
        start: 40,
        duration: 6,
        staffId: "tech-main",
        client: "Callable Main Client",
        phone: "7805550199",
        note: "manicure"
      }
    })).data;
    assert.equal(manualResult.ok, true);
    const callableAppointment = await getDoc(doc(manager.firestore, "appointments", manualId));
    assert.equal(callableAppointment.exists(), true);
    assert.equal(callableAppointment.data().phone, "7805550199");

    const requestId = "current-main-online-request";
    const onlineResult = (await httpsCallable(publicBooking.functions,
      "createOnlineBookingRequest")({
      requestId,
      client: "Synthetic Online Main",
      phone: "7805550188",
      date: "2026-11-12",
      start: 24,
      staffId: "tech-main",
      serviceDetails: "pedicure",
      selectedServices: [],
      consentAccepted: true,
      consentVersion: "privacy-consent-v3-2026-09-06"
    })).data;
    assert.equal(onlineResult.ok, true);
    const onlineRef = db.collection("appointments").doc(onlineResult.appointmentId);
    const onlineData = (await onlineRef.get()).data();
    assert.equal(onlineData.source, "online_booking");
    assert.equal(onlineData.status, "request");
    assert.equal(onlineData.phone, "7805550188");
    await assert.rejects(getDoc(doc(publicBooking.firestore,
      "appointments", onlineResult.appointmentId)));

    await onlineRef.set({ smsConsent: false }, { merge: true });
    const confirmData = (await onlineRef.get()).data();
    const confirmed = (await httpsCallable(manager.functions, "mutateAppointment")({
      mode: "confirm",
      appointmentId: onlineResult.appointmentId,
      mutationId: "current-main-mutation-confirm",
      expectedRevision: confirmData.revision,
      appointment: {
        date: confirmData.date,
        start: confirmData.start,
        duration: confirmData.duration,
        staffId: confirmData.staffId,
        client: confirmData.client,
        phone: confirmData.phone,
        note: confirmData.note
      }
    })).data;
    assert.equal(confirmed.ok, true);
    assert.equal((await onlineRef.get()).data().status, "confirmed");
  } finally {
    await Promise.all([manager, staff, publicBooking].map(client => deleteApp(client.app)));
    await admin.app().delete();
  }
});
