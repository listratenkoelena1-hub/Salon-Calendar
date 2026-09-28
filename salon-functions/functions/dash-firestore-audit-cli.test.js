"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decodeFirestoreValue,
  documentFromRest,
  parseOptions
} = require("./dash-firestore-audit-cli");

test("one-day Firestore audit accepts only a project and ISO date", () => {
  assert.deepEqual(parseOptions([
    "--project=rosesnails-calendar",
    "--date=2026-09-28"
  ]), {
    projectId: "rosesnails-calendar",
    date: "2026-09-28"
  });
  assert.throws(() => parseOptions(["--project=rosesnails-calendar", "--date=09/28/2026"]));
  assert.throws(() => parseOptions([
    "--project=rosesnails-calendar",
    "--date=2026-09-28",
    "--apply"
  ]));
});

test("decodes Firestore fields without any write operation", () => {
  const document = documentFromRest({
    name: "projects/demo/databases/(default)/documents/appointments/a1",
    createTime: "2026-09-01T00:00:00Z",
    fields: {
      client: { stringValue: "Sample" },
      start: { integerValue: "8" },
      canceled: { booleanValue: false },
      services: { arrayValue: { values: [{ stringValue: "Pedicure" }] } }
    }
  });
  assert.equal(document.id, "a1");
  assert.equal(document.start, 8);
  assert.deepEqual(document.services, ["Pedicure"]);
  assert.equal(decodeFirestoreValue({ mapValue: { fields: {
    duration: { integerValue: "4" }
  } } }).duration, 4);
});
