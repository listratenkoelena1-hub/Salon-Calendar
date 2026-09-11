"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { hashPhone } = require("./client-history-core");
const {
  APPOINTMENT_PRIVATE_COLLECTION,
  CLIENT_COLLECTION,
  CLIENT_HISTORY_COLLECTION,
  CLIENT_PHONE_INDEX_COLLECTION,
  CLIENT_PROFILE_COLLECTION,
  applyClientIdentityPlan,
  buildAppointmentPrivateData,
  buildClientHistoryData,
  getCachedProfileSummary,
  planClientIdentityInTransaction,
  readPhoneClient,
  writeClientAppointmentRecords
} = require("./client-history-store");

const FieldValue = {
  serverTimestamp: () => ({ serverTimestamp: true }),
  arrayUnion: (...values) => ({ arrayUnion: values })
};

class FakeSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = data !== undefined;
    this._data = data;
  }

  data() {
    return this._data;
  }
}

class FakeRef {
  constructor(db, collection, id) {
    this.db = db;
    this.collectionName = collection;
    this.id = id;
    this.path = `${collection}/${id}`;
  }

  async get() {
    return new FakeSnapshot(this, this.db.records[this.path]);
  }
}

class FakeDb {
  constructor(records = {}) {
    this.nextId = 1;
    this.records = records;
  }

  collection(name) {
    return {
      doc: id => new FakeRef(this, name, id || `random-${this.nextId++}`)
    };
  }

  async getAll(...refs) {
    return refs.map(ref => new FakeSnapshot(ref, this.records[ref.path]));
  }
}

class FakeTransaction {
  constructor(records = {}) {
    this.records = records;
    this.writes = [];
  }

  async get(ref) {
    return new FakeSnapshot(ref, this.records[ref.path]);
  }

  set(ref, data, options) {
    this.writes.push({ type: "set", ref, data, options });
  }

  delete(ref) {
    this.writes.push({ type: "delete", ref });
  }
}

test("plans a random phone client and a separate random person profile", async () => {
  const db = new FakeDb();
  const transaction = new FakeTransaction();
  const plan = await planClientIdentityInTransaction({
    transaction,
    db,
    FieldValue,
    pepper: "test-pepper",
    phone: "(780) 555-0123",
    clientName: "Naomi",
    allowCreate: true
  });

  assert.equal(plan.createdClient, true);
  assert.equal(plan.createdProfile, true);
  assert.match(plan.clientId, /^random-/);
  assert.match(plan.clientProfileId, /^random-/);
  assert.notEqual(plan.clientId, plan.clientProfileId);
  assert.equal(plan.phoneIndexRef.collectionName, CLIENT_PHONE_INDEX_COLLECTION);
  assert.equal(plan.phoneNormalized, "+17805550123");

  applyClientIdentityPlan(transaction, plan, FieldValue);
  assert.equal(transaction.writes.filter(write => write.type === "set").length, 3);
});

test("reuses the correct person branch for a small unique spelling mistake", async () => {
  const db = new FakeDb();
  const key = hashPhone("7805550123", "test-pepper");
  const transaction = new FakeTransaction({
    [`${CLIENT_PHONE_INDEX_COLLECTION}/${key}`]: { clientId: "client-one" },
    [`${CLIENT_COLLECTION}/client-one`]: { profileIds: ["naomi", "deborah"] },
    [`${CLIENT_PROFILE_COLLECTION}/naomi`]: {
      clientId: "client-one",
      displayName: "Naomi",
      nameNormalized: "naomi",
      aliases: []
    },
    [`${CLIENT_PROFILE_COLLECTION}/deborah`]: {
      clientId: "client-one",
      displayName: "Deborah",
      nameNormalized: "deborah",
      aliases: []
    }
  });
  const plan = await planClientIdentityInTransaction({
    transaction,
    db,
    FieldValue,
    pepper: "test-pepper",
    phone: "7805550123",
    clientName: "Naomii"
  });

  assert.equal(plan.createdClient, false);
  assert.equal(plan.createdProfile, false);
  assert.equal(plan.clientProfileId, "naomi");
  assert.equal(plan.matchType, "close");
  assert.equal(plan.alias, "Naomii");
  applyClientIdentityPlan(transaction, plan, FieldValue);
  const aliasWrite = transaction.writes.find(write => write.ref.id === "naomi");
  assert.deepEqual(aliasWrite.data.aliases, ["Naomii"]);
});

test("creates a separate person branch when another name uses the same phone", async () => {
  const db = new FakeDb();
  const key = hashPhone("7805550123", "test-pepper");
  const transaction = new FakeTransaction({
    [`${CLIENT_PHONE_INDEX_COLLECTION}/${key}`]: { clientId: "client-one" },
    [`${CLIENT_COLLECTION}/client-one`]: { profileIds: ["naomi"] },
    [`${CLIENT_PROFILE_COLLECTION}/naomi`]: {
      clientId: "client-one",
      displayName: "Naomi",
      nameNormalized: "naomi",
      aliases: []
    }
  });
  const plan = await planClientIdentityInTransaction({
    transaction,
    db,
    FieldValue,
    pepper: "test-pepper",
    phone: "7805550123",
    clientName: "Deborah"
  });

  assert.equal(plan.clientId, "client-one");
  assert.equal(plan.createdClient, false);
  assert.equal(plan.createdProfile, true);
  assert.notEqual(plan.clientProfileId, "naomi");
});

test("does not rewrite an unchanged phone identity", async () => {
  const db = new FakeDb();
  const key = hashPhone("7805550123", "test-pepper");
  const records = {
    [`${CLIENT_PHONE_INDEX_COLLECTION}/${key}`]: { clientId: "client-one" },
    [`${CLIENT_COLLECTION}/client-one`]: { profileIds: ["naomi"] },
    [`${CLIENT_PROFILE_COLLECTION}/naomi`]: {
      clientId: "client-one",
      displayName: "Naomi",
      nameNormalized: "naomi",
      aliases: []
    }
  };
  const transaction = new FakeTransaction(records);
  const plan = await planClientIdentityInTransaction({
    transaction,
    db,
    FieldValue,
    pepper: "test-pepper",
    phone: "7805550123",
    clientName: "Naomi"
  });
  applyClientIdentityPlan(transaction, plan, FieldValue);
  assert.deepEqual(transaction.writes, []);
});

test("does not create identity or history without a valid phone", async () => {
  const plan = await planClientIdentityInTransaction({
    transaction: new FakeTransaction(),
    db: new FakeDb(),
    FieldValue,
    pepper: "test-pepper",
    phone: "",
    clientName: "Barbara"
  });
  assert.equal(plan, null);
});

test("reads one exact phone client without exposing a prefix or scanning clients", async () => {
  const key = hashPhone("7805550123", "test-pepper");
  const db = new FakeDb({
    [`${CLIENT_PHONE_INDEX_COLLECTION}/${key}`]: { clientId: "client-one" },
    [`${CLIENT_COLLECTION}/client-one`]: {
      phoneDisplay: "(780) 555-0123",
      profileIds: ["naomi", "deborah"]
    },
    [`${CLIENT_PROFILE_COLLECTION}/naomi`]: { clientId: "client-one", displayName: "Naomi" },
    [`${CLIENT_PROFILE_COLLECTION}/deborah`]: { clientId: "client-one", displayName: "Deborah" }
  });

  assert.equal(await readPhoneClient({
    db,
    pepper: "test-pepper",
    phone: "555-0123"
  }), null);

  const result = await readPhoneClient({
    db,
    pepper: "test-pepper",
    phone: "7805550123"
  });
  assert.equal(result.clientId, "client-one");
  assert.deepEqual(result.profiles.map(profile => profile.displayName), ["Naomi", "Deborah"]);
});

test("uses only a versioned server-built profile summary", () => {
  const historySummary = { hands: { key: "hard_gel_refill", count: 3 } };
  assert.equal(getCachedProfileSummary({ historySummary }), null);
  assert.equal(getCachedProfileSummary({ historySummaryVersion: 0, historySummary }), null);
  assert.deepEqual(
    getCachedProfileSummary({ historySummaryVersion: 1, historySummary }),
    historySummary
  );
});

test("builds private contact and service history records without exposing them in the appointment", () => {
  const identity = {
    clientId: "client-one",
    clientProfileId: "profile-one",
    phoneNormalized: "+17805550123",
    phoneDisplay: "(780) 555-0123",
    phoneLast4: "0123",
    phoneKey: "phone-hash"
  };
  const appointment = {
    client: "Naomi",
    date: "2026-09-20",
    start: 20,
    staffId: "natasha",
    note: "Mani hard gel refill design",
    duration: 8,
    standardDuration: 6,
    status: "confirmed",
    source: "online_booking"
  };
  const privateData = buildAppointmentPrivateData("appointment-one", appointment, identity, FieldValue);
  const history = buildClientHistoryData("appointment-one", appointment, identity, FieldValue);

  assert.equal(privateData.phoneNormalized, "+17805550123");
  assert.equal(privateData.clientProfileId, "profile-one");
  assert.equal(history.serviceFingerprint, "hands:hard_gel_refill:design");
  assert.equal(history.standardDuration, 6);
  assert.equal(history.duration, 8);
  assert.equal(history.historyEligible, true);
});

test("pending and declined booking records stay visible in history but cannot train preferences", () => {
  const identity = {
    clientId: "client-one",
    clientProfileId: "profile-one"
  };
  const pending = buildClientHistoryData("pending", {
    client: "Naomi",
    note: "Mani gel polish",
    status: "request",
    lastAction: "online_request_created"
  }, identity, FieldValue);
  const declined = buildClientHistoryData("declined", {
    client: "Naomi",
    note: "Pedi gel polish",
    status: "declined",
    lastAction: "online_request_declined"
  }, identity, FieldValue);
  assert.equal(pending.historyEligible, false);
  assert.equal(declined.historyEligible, false);
});

test("writes or removes both private appointment documents together", () => {
  const db = new FakeDb();
  const transaction = new FakeTransaction();
  writeClientAppointmentRecords(transaction, {
    db,
    FieldValue,
    appointmentId: "appointment-one",
    appointment: { client: "Naomi", note: "Pedi", duration: 4 },
    identity: null
  });
  assert.deepEqual(
    transaction.writes.map(write => [write.type, write.ref.collectionName]),
    [
      ["delete", APPOINTMENT_PRIVATE_COLLECTION],
      ["delete", CLIENT_HISTORY_COLLECTION]
    ]
  );
});

test("invalidates the cached summary whenever a private history record changes", () => {
  const db = new FakeDb();
  const transaction = new FakeTransaction();
  writeClientAppointmentRecords(transaction, {
    db,
    FieldValue,
    appointmentId: "appointment-one",
    appointment: { client: "Naomi", note: "Pedi", duration: 4 },
    identity: {
      clientId: "client-one",
      clientProfileId: "profile-one",
      phoneNormalized: "+17805550123",
      phoneDisplay: "7805550123",
      phoneLast4: "0123",
      phoneKey: "phone-hash"
    }
  });
  const invalidation = transaction.writes.find(write => (
    write.type === "set" &&
    write.ref.collectionName === CLIENT_PROFILE_COLLECTION &&
    write.ref.id === "profile-one"
  ));
  assert.equal(invalidation?.data?.historySummaryVersion, 0);
});
