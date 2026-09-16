"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyBackfillAppointment,
  migrateLegacyAppointmentInTransaction,
  summarizeBackfillAppointments
} = require("./client-history-backfill-core");
const {
  CLIENT_COLLECTION,
  CLIENT_HISTORY_COLLECTION,
  CLIENT_PHONE_INDEX_COLLECTION,
  CLIENT_PROFILE_COLLECTION
} = require("./client-history-store");

const FieldValue = {
  serverTimestamp: () => ({ serverTimestamp: true }),
  arrayUnion: (...values) => ({ arrayUnion: values })
};

class FakeRef {
  constructor(db, collectionName, id) {
    this.db = db;
    this.collectionName = collectionName;
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }
}

class FakeSnapshot {
  constructor(ref, data) {
    this.id = ref.id;
    this.exists = data !== undefined;
    this.value = data;
  }

  data() {
    return this.value;
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
    this.writes = [];
  }

  async get(ref) {
    return new FakeSnapshot(ref, this.db.records.get(ref.path));
  }

  set(ref, data, options = {}) {
    this.writes.push({ kind: "set", ref, data, options });
  }

  delete(ref) {
    this.writes.push({ kind: "delete", ref });
  }

  commit() {
    for (const write of this.writes) {
      if (write.kind === "delete") {
        this.db.records.delete(write.ref.path);
        continue;
      }
      const old = write.options.merge ? this.db.records.get(write.ref.path) || {} : {};
      const next = { ...old };
      for (const [key, value] of Object.entries(write.data)) {
        next[key] = value && Array.isArray(value.arrayUnion)
          ? [...new Set([...(Array.isArray(old[key]) ? old[key] : []), ...value.arrayUnion])]
          : value;
      }
      this.db.records.set(write.ref.path, next);
    }
  }
}

class FakeDb {
  constructor(records = {}) {
    this.records = new Map(Object.entries(records));
    this.nextId = 1;
    this.lastTransaction = null;
  }

  collection(name) {
    return { doc: id => new FakeRef(this, name, id || `random-${this.nextId++}`) };
  }

  async runTransaction(callback) {
    const transaction = new FakeTransaction(this);
    this.lastTransaction = transaction;
    const result = await callback(transaction);
    transaction.commit();
    return result;
  }

  countCollection(name) {
    return [...this.records.keys()].filter(path => path.startsWith(`${name}/`)).length;
  }
}

function syntheticAppointment({
  client = "Naomi",
  phone = "(780) 555-0123",
  source = "online_booking",
  status = "confirmed"
} = {}) {
  return {
    date: "2026-09-05",
    start: 40,
    staffId: "tech-one",
    client,
    phone,
    phoneLookup: "7805550123",
    note: "hard gel refill",
    duration: 8,
    bookingStandardDuration: 6,
    source,
    type: "appointment",
    status,
    lastAction: status === "declined" ? "online_request_declined" : "online_request_confirmed",
    canceled: status === "declined"
  };
}

async function migrate(db, appointmentId) {
  return db.runTransaction(transaction => migrateLegacyAppointmentInTransaction({
    transaction,
    db,
    FieldValue,
    appointmentId,
    pepper: "synthetic-test-pepper"
  }));
}

test("dry-run classifies appointments without showing names or phone numbers", () => {
  const counts = summarizeBackfillAppointments([
    syntheticAppointment(),
    syntheticAppointment({ client: "Deborah", source: null }),
    syntheticAppointment({ phone: "" }),
    syntheticAppointment({ phone: "not a phone" }),
    syntheticAppointment({ client: "" }),
    { privacySchemaVersion: 1, hasPrivateContact: false, phone: "" }
  ]);
  assert.deepEqual(counts, {
    total: 6,
    booking: 4,
    candidate: 2,
    candidateBooking: 1,
    candidateOther: 1,
    withoutPhone: 1,
    invalidPhone: 1,
    missingName: 1,
    alreadyVersioned: 1,
    inconsistentPublicPhone: 0,
    distinctCandidatePhones: 1,
    distinctCandidatePhoneNames: 2
  });
  assert.doesNotMatch(JSON.stringify(counts), /Naomi|Deborah|7805550123/);
});

test("migrates one online appointment atomically without losing its provenance or duration", async () => {
  const db = new FakeDb({
    "appointments/online-one": syntheticAppointment()
  });
  const result = await migrate(db, "online-one");
  assert.deepEqual(result, {
    status: "migrated",
    booking: true,
    createdClient: true,
    createdProfile: true
  });
  const publicAppointment = db.records.get("appointments/online-one");
  const privateAppointment = db.records.get("appointmentPrivate/online-one");
  const history = db.records.get("clientAppointmentHistory/online-one");
  assert.equal(publicAppointment.privacySchemaVersion, 1);
  assert.equal(publicAppointment.hasPrivateContact, true);
  assert.equal(publicAppointment.phone, undefined);
  assert.equal(publicAppointment.phoneLookup, undefined);
  assert.equal(publicAppointment.source, "online_booking");
  assert.equal(publicAppointment.status, "confirmed");
  assert.equal(publicAppointment.duration, 8);
  assert.equal(privateAppointment.phoneNormalized, "+17805550123");
  assert.equal(history.clientId, privateAppointment.clientId);
  assert.equal(history.clientProfileId, privateAppointment.clientProfileId);
  assert.equal(history.standardDuration, 6);
  assert.equal(history.duration, 8);
  assert.equal(history.staffId, "tech-one");
  assert.equal(history.historyEligible, true);
  assert.equal(db.countCollection(CLIENT_PHONE_INDEX_COLLECTION), 1);
  assert.equal(db.countCollection(CLIENT_COLLECTION), 1);
  assert.equal(db.countCollection(CLIENT_PROFILE_COLLECTION), 1);
  assert.equal(db.countCollection(CLIENT_HISTORY_COLLECTION), 1);

  const rerun = await migrate(db, "online-one");
  assert.equal(rerun.status, "already-versioned");
  assert.equal(db.lastTransaction.writes.length, 0);
});

test("reruns reuse one phone client while keeping separate people on that phone", async () => {
  const db = new FakeDb({
    "appointments/person-one": syntheticAppointment(),
    "appointments/person-two": syntheticAppointment({ client: "Deborah", source: null }),
    "appointments/person-one-again": syntheticAppointment({ client: "Naomi" })
  });
  await migrate(db, "person-one");
  await migrate(db, "person-two");
  await migrate(db, "person-one-again");
  const one = db.records.get("appointmentPrivate/person-one");
  const two = db.records.get("appointmentPrivate/person-two");
  const oneAgain = db.records.get("appointmentPrivate/person-one-again");
  assert.equal(one.clientId, two.clientId);
  assert.equal(one.clientId, oneAgain.clientId);
  assert.notEqual(one.clientProfileId, two.clientProfileId);
  assert.equal(one.clientProfileId, oneAgain.clientProfileId);
  assert.equal(db.countCollection(CLIENT_PHONE_INDEX_COLLECTION), 1);
  assert.equal(db.countCollection(CLIENT_COLLECTION), 1);
  assert.equal(db.countCollection(CLIENT_PROFILE_COLLECTION), 2);
  assert.equal(db.countCollection(CLIENT_HISTORY_COLLECTION), 3);
});

test("declined online requests enter history without training a service preference", async () => {
  const db = new FakeDb({
    "appointments/declined-one": syntheticAppointment({ status: "declined" })
  });
  await migrate(db, "declined-one");
  const history = db.records.get("clientAppointmentHistory/declined-one");
  assert.equal(history.source, "online_booking");
  assert.equal(history.status, "declined");
  assert.equal(history.historyEligible, false);
});

test("appointments without valid phones remain untouched", async () => {
  const db = new FakeDb({
    "appointments/no-phone": syntheticAppointment({ phone: "" }),
    "appointments/invalid-phone": syntheticAppointment({ phone: "123" }),
    "appointments/no-name": syntheticAppointment({ client: "" })
  });
  for (const [id, reason] of [
    ["no-phone", "without-phone"],
    ["invalid-phone", "invalid-phone"],
    ["no-name", "missing-name"]
  ]) {
    assert.equal((await migrate(db, id)).status, reason);
    assert.equal(db.lastTransaction.writes.length, 0);
    assert.equal(db.records.get(`appointments/${id}`).privacySchemaVersion, undefined);
  }
  assert.equal(db.countCollection(CLIENT_COLLECTION), 0);
});

test("inconsistent partial migrations stop without rewriting appointments", async () => {
  const db = new FakeDb({
    "appointments/unsafe": { ...syntheticAppointment(), privacySchemaVersion: 1 },
    "appointments/partial": syntheticAppointment(),
    "appointmentPrivate/partial": { phoneNormalized: "+17805550123" }
  });
  assert.equal(classifyBackfillAppointment(db.records.get("appointments/unsafe")).status,
    "inconsistent-public-phone");
  await assert.rejects(migrate(db, "unsafe"), /public phone/);
  assert.equal(db.lastTransaction.writes.length, 0);
  await assert.rejects(migrate(db, "partial"), /unexpected private records/);
  assert.equal(db.lastTransaction.writes.length, 0);
});

test("historic backfill does not fuzzy-merge near-spelled names on a shared phone", async () => {
  const db = new FakeDb({
    "appointments/exact": syntheticAppointment({ client: "Darlene" }),
    "appointments/near": syntheticAppointment({ client: "Darlenne" })
  });
  await migrate(db, "exact");
  await migrate(db, "near");
  const exact = db.records.get("appointmentPrivate/exact");
  const near = db.records.get("appointmentPrivate/near");
  assert.equal(exact.clientId, near.clientId);
  assert.notEqual(exact.clientProfileId, near.clientProfileId);
});
