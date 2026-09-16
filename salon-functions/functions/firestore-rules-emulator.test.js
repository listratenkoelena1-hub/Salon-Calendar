"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} = require("@firebase/rules-unit-testing");
const { collection, doc, getDoc, getDocs, setDoc } = require("firebase/firestore");

const hostAndPort = String(process.env.FIRESTORE_EMULATOR_HOST || "");
if (!hostAndPort) throw new Error("This test may only run with FIRESTORE_EMULATOR_HOST set.");
const [host, portText] = hostAndPort.split(":");
const projectId = "demo-booking-client-backfill";
const rules = fs.readFileSync(path.join(__dirname, "..", "..", "salon-calendar", "firestore.rules"), "utf8");

test("old phone-free appointments stay readable while private client records are closed", async () => {
  const environment = await initializeTestEnvironment({
    projectId,
    firestore: { host, port: Number(portText), rules }
  });
  try {
    await environment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await setDoc(doc(db, "users", "manager-one"), { role: "manager" });
      await setDoc(doc(db, "users", "manager-two"), { role: "manager" });
      await setDoc(doc(db, "users", "staff-one"), { role: "staff", staffId: "tech-one" });
      await setDoc(doc(db, "appointments", "legacy-no-phone"), {
        client: "Synthetic Client", date: "2026-09-01", note: "pedicure"
      });
      await setDoc(doc(db, "appointments", "new-private"), {
        client: "Synthetic Client", date: "2026-09-15",
        privacySchemaVersion: 1, hasPrivateContact: true
      });
      await setDoc(doc(db, "appointmentPrivate", "new-private"), {
        clientId: "synthetic-client-id", phoneDisplay: "780-555-0100"
      });
      await setDoc(doc(db, "clientLookup", "synthetic-client-id"), {
        phoneDisplay: "780-555-0100"
      });
      await setDoc(doc(db, "clientPhoneIndex", "synthetic-hash"), {
        clientId: "synthetic-client-id"
      });
      await setDoc(doc(db, "clientProfiles", "synthetic-profile"), {
        clientId: "synthetic-client-id"
      });
      await setDoc(doc(db, "clientAppointmentHistory", "new-private"), {
        clientId: "synthetic-client-id"
      });
      await setDoc(doc(db, "activityLog", "synthetic-log"), { action: "created", phone: "780-555-0100" });
      await setDoc(doc(db, "staff", "tech-one"), { name: "Tech One", color: "#abcdef" });
      await setDoc(doc(db, "operationalSettings", "synthetic-setting"), { enabled: true });
    });

    const managerOne = environment.authenticatedContext("manager-one").firestore();
    const managerTwo = environment.authenticatedContext("manager-two").firestore();
    const staff = environment.authenticatedContext("staff-one").firestore();
    const stranger = environment.unauthenticatedContext().firestore();
    for (const db of [managerOne, managerTwo, staff]) {
      const legacy = await assertSucceeds(getDoc(doc(db, "appointments", "legacy-no-phone")));
      assert.equal(legacy.exists(), true);
      await assertSucceeds(getDoc(doc(db, "appointments", "new-private")));
      const list = await assertSucceeds(getDocs(collection(db, "appointments")));
      assert.ok(list.size >= 2);
      assert.ok(list.docs.some(snapshot => snapshot.id === "legacy-no-phone"));
      await assertSucceeds(getDoc(doc(db, "staff", "tech-one")));
      await assertSucceeds(getDoc(doc(db, "operationalSettings", "synthetic-setting")));
      for (const privateCollection of [
        "appointmentPrivate", "clientLookup", "clientPhoneIndex",
        "clientProfiles", "clientAppointmentHistory"
      ]) {
        await assertFails(getDoc(doc(db, privateCollection,
          privateCollection === "appointmentPrivate" || privateCollection === "clientAppointmentHistory"
            ? "new-private" : privateCollection === "clientPhoneIndex"
              ? "synthetic-hash" : privateCollection === "clientProfiles"
                ? "synthetic-profile" : "synthetic-client-id")));
        await assertFails(getDocs(collection(db, privateCollection)));
      }
      await assertFails(setDoc(doc(db, "appointments", "forged"), { client: "Synthetic" }));
    }
    await assertFails(getDoc(doc(stranger, "appointments", "legacy-no-phone")));
    await assertSucceeds(getDoc(doc(managerOne, "activityLog", "synthetic-log")));
    await assertFails(getDoc(doc(staff, "activityLog", "synthetic-log")));
    await assertFails(getDoc(doc(stranger, "activityLog", "synthetic-log")));
  } finally {
    await environment.clearFirestore();
    await environment.cleanup();
  }
});
