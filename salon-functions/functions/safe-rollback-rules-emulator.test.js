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
const { collection, doc, getDoc, getDocs, setDoc, updateDoc } = require("firebase/firestore");

const hostAndPort = String(process.env.FIRESTORE_EMULATOR_HOST || "");
if (!hostAndPort) throw new Error("This test may only run with FIRESTORE_EMULATOR_HOST set.");
const [host, portText] = hostAndPort.split(":");
const projectId = "demo-client-history-safe-rollback";
const rules = fs.readFileSync(path.join(
  __dirname,
  "..",
  "..",
  "firebase-rollbacks",
  "firestore.rules.safe-rollback-client-history.rules"
), "utf8");

test("safe rollback preserves current main while private client data stays closed", async () => {
  const environment = await initializeTestEnvironment({
    projectId,
    firestore: { host, port: Number(portText), rules }
  });
  try {
    await environment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await setDoc(doc(db, "users", "manager-one"), { role: "manager" });
      await setDoc(doc(db, "users", "staff-one"), { role: "staff", staffId: "tech-one" });
      await setDoc(doc(db, "staff", "tech-one"), {
        name: "Synthetic Tech", color: "#abcdef", bookingDurations: {}
      });
      await setDoc(doc(db, "appointments", "legacy-main"), {
        client: "Legacy Main", date: "2026-09-16", phone: "7805550100"
      });
      await setDoc(doc(db, "appointmentPrivate", "private-one"), {
        phone: "7805550100", clientId: "client-one"
      });
      await setDoc(doc(db, "clientLookup", "client-one"), {
        phone: "7805550100"
      });
      await setDoc(doc(db, "clientProfiles", "profile-one"), {
        clientId: "client-one"
      });
      await setDoc(doc(db, "clientPhoneIndex", "phone-hash"), {
        clientId: "client-one"
      });
      await setDoc(doc(db, "clientAppointmentHistory", "private-one"), {
        clientId: "client-one"
      });
      await setDoc(doc(db, "onlineBookingEmailContacts", "contact-one"), {
        email: "synthetic@example.test"
      });
      await setDoc(doc(db, "activityLog", "existing-log"), {
        eventType: "legacy", phone: "7805550100"
      });
      await setDoc(doc(db, "OffWork", "existing-off"), {
        date: "2026-09-16", staffId: "tech-one", allDay: true
      });
    });

    const manager = environment.authenticatedContext("manager-one").firestore();
    const staff = environment.authenticatedContext("staff-one").firestore();
    const anonymous = environment.unauthenticatedContext().firestore();

    for (const db of [manager, staff]) {
      assert.equal((await assertSucceeds(getDoc(doc(db,
        "appointments", "legacy-main")))).exists(), true);
      await assertFails(setDoc(doc(db, "appointments", "direct-write"), {
        client: "Forbidden"
      }));
      assert.equal((await assertSucceeds(getDoc(doc(db,
        "OffWork", "existing-off")))).exists(), true);
      await assertSucceeds(setDoc(doc(db, "OffWork", "new-off"), {
        date: "2026-09-17", staffId: "tech-one", allDay: true
      }));
      // The rollback deliberately restores current-main activity log behavior.
      assert.equal((await assertSucceeds(getDoc(doc(db,
        "activityLog", "existing-log")))).exists(), true);
      await assertSucceeds(setDoc(doc(db, "activityLog", `new-log-${db === manager ? "manager" : "staff"}`), {
        eventType: "legacy", phone: "7805550199"
      }));

      for (const [name, id] of [
        ["appointmentPrivate", "private-one"],
        ["clientLookup", "client-one"],
        ["clientProfiles", "profile-one"],
        ["clientPhoneIndex", "phone-hash"],
        ["clientAppointmentHistory", "private-one"],
        ["onlineBookingEmailContacts", "contact-one"]
      ]) {
        await assertFails(getDoc(doc(db, name, id)));
        await assertFails(getDocs(collection(db, name)));
      }
    }

    await assertSucceeds(updateDoc(doc(staff, "staff", "tech-one"), {
      color: "#123456",
      bookingDurations: { "Manicure Gel Polish": 6 }
    }));
    await assertFails(updateDoc(doc(staff, "staff", "tech-one"), {
      name: "Forbidden rename"
    }));
    await assertFails(getDoc(doc(anonymous, "appointments", "legacy-main")));
    await assertFails(getDoc(doc(anonymous, "activityLog", "existing-log")));
  } finally {
    await environment.clearFirestore();
    await environment.cleanup();
  }
});
