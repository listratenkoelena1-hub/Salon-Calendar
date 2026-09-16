"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertApplyAuthorized,
  countAppointmentsViaRest,
  listAppointmentsViaRest,
  parseOptions,
  verifyMigratedAppointment
} = require("./client-history-backfill-cli");

test("dry-run is the default and real writes need every independent guard", () => {
  const dry = parseOptions(["--project=rosesnails-calendar"]);
  assert.equal(dry.apply, false);
  assert.throws(() => assertApplyAuthorized(dry, {}), /dry run/);
  const apply = parseOptions([
    "--project=rosesnails-calendar", "--apply",
    "--confirm-project=rosesnails-calendar", "--rules-verified", "--backend-verified"
  ]);
  assert.throws(() => assertApplyAuthorized(apply, {}), /ENABLE_WRITES/);
  assert.throws(() => assertApplyAuthorized(apply, {
    BOOKING_BACKFILL_ENABLE_WRITES: "YES"
  }), /PEPPER/);
  assert.doesNotThrow(() => assertApplyAuthorized(apply, {
    BOOKING_BACKFILL_ENABLE_WRITES: "YES", CLIENT_LOOKUP_PEPPER: "synthetic-secret"
  }));
  assert.throws(() => parseOptions(["--project=rosesnails-calendar", "--limit=1"]), /only available/);
  assert.throws(() => parseOptions(["--project=rosesnails-calendar", "--apply=YES"]), /must not have a value/);
});

test("read-only listing uses a field mask and checks paginated IDs", async () => {
  const requests = [];
  const fetchImpl = async url => {
    requests.push(new URL(url));
    return { ok: true, json: async () => requests.length === 1 ? {
      documents: [{ name: "projects/demo/databases/(default)/documents/appointments/a", fields: {
        phone: { stringValue: "7805550123" }, client: { stringValue: "Naomi" }
      } }], nextPageToken: "second"
    } : {
      documents: [{ name: "projects/demo/databases/(default)/documents/appointments/b", fields: {
        phone: { stringValue: "" }, client: { stringValue: "Deborah" }
      } }]
    } };
  };
  const appointments = await listAppointmentsViaRest({
    projectId: "demo-rosesnails", accessToken: "synthetic-token", fetchImpl
  });
  assert.deepEqual(appointments.map(item => item.id), ["a", "b"]);
  assert.equal(requests[0].searchParams.get("pageSize"), "500");
  assert.deepEqual(requests[0].searchParams.getAll("mask.fieldPaths").sort(), [
    "client", "hasPrivateContact", "phone", "privacySchemaVersion", "source", "status", "type"
  ].sort());
  assert.equal(requests[1].searchParams.get("pageToken"), "second");
  assert.throws(() => parseOptions(["--project=demo-rosesnails", "--unknown"]), /Unknown/);
});

test("independent count reads a Firestore aggregation without downloading records", async () => {
  const fetchImpl = async (_url, options) => {
    assert.equal(options.method, "POST");
    assert.equal(JSON.parse(options.body).structuredAggregationQuery.aggregations[0].alias, "total");
    return { ok: true, json: async () => [{ result: {
      aggregateFields: { total: { integerValue: "5022" } }
    } }] };
  };
  assert.equal(await countAppointmentsViaRest({
    projectId: "demo-rosesnails", accessToken: "synthetic-token", fetchImpl
  }), 5022);
});

test("post-migration check compares source to fresh private and history records", async () => {
  const snapshots = [
    { exists: true, data: () => ({ privacySchemaVersion: 1, hasPrivateContact: true,
      source: "online_booking" }) },
    { exists: true, data: () => ({ clientId: "client-1", clientProfileId: "profile-1",
      source: "online_booking" }) },
    { exists: true, data: () => ({ clientId: "client-1", clientProfileId: "profile-1",
      source: "online_booking" }) }
  ];
  const db = { collection: name => ({ doc: id => `${name}/${id}` }),
    getAll: async () => snapshots };
  await assert.doesNotReject(verifyMigratedAppointment(db, "appointment-1"));
  snapshots[0] = { exists: true, data: () => ({ privacySchemaVersion: 1,
    hasPrivateContact: true, source: "calendar" }) };
  await assert.rejects(verifyMigratedAppointment(db, "appointment-1"), /verification failed/);
});
