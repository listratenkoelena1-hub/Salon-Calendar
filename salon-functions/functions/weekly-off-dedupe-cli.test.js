"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertApplyAuthorized,
  commitDeletes,
  listWeeklyOffViaRest,
  parseOptions,
  weeklyRuleFromRest
} = require("./weekly-off-dedupe-cli");

test("defaults to read-only and requires independent guards for atomic deletion", () => {
  const dry = parseOptions(["--project=rosesnails-calendar", "--as-of=2026-09-27"]);
  assert.equal(dry.apply, false);
  assert.throws(() => assertApplyAuthorized(dry, {}), /dry run/);
  const apply = parseOptions([
    "--project=rosesnails-calendar", "--as-of=2026-09-27", "--apply",
    "--confirm-project=rosesnails-calendar", "--expect-groups=4", "--expect-deletions=4"
  ]);
  assert.throws(() => assertApplyAuthorized(apply, {}), /ENABLE_WRITES/);
  assert.doesNotThrow(() => assertApplyAuthorized(apply, {
    WEEKLY_OFF_DEDUPE_ENABLE_WRITES: "YES"
  }));
});

test("reads rule fields and Firestore create/update metadata", async () => {
  const document = {
    name: "projects/demo/databases/(default)/documents/WeeklyOff/rule-1",
    createTime: "2026-01-01T00:00:00Z",
    updateTime: "2026-02-01T00:00:00Z",
    fields: {
      staffId: { stringValue: "inna" },
      weekday: { integerValue: "3" },
      allDay: { booleanValue: false },
      start: { integerValue: "0" },
      end: { integerValue: "17" }
    }
  };
  const rule = weeklyRuleFromRest(document);
  assert.equal(rule.id, "rule-1");
  assert.equal(rule.createTime, document.createTime);
  assert.equal(rule.end, 17);

  const listed = await listWeeklyOffViaRest({
    projectId: "demo-project",
    accessToken: "token",
    fetchImpl: async () => ({ ok: true, json: async () => ({ documents: [document] }) })
  });
  assert.equal(listed[0].id, "rule-1");
});

test("sends every reviewed deletion as one atomic Firestore commit with update preconditions", async () => {
  let request = null;
  const response = await commitDeletes({
    projectId: "demo-project",
    accessToken: "token",
    rules: [
      { name: "projects/demo-project/databases/(default)/documents/WeeklyOff/old", updateTime: "2026-01-02T00:00:00Z" },
      { name: "projects/demo-project/databases/(default)/documents/WeeklyOff/older", updateTime: "2026-01-03T00:00:00Z" }
    ],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ commitTime: "2026-09-27T12:00:00Z" }) };
    }
  });
  const body = JSON.parse(request.options.body);
  assert.equal(body.writes.length, 2);
  assert.equal(body.writes[0].currentDocument.updateTime, "2026-01-02T00:00:00Z");
  assert.equal(response.commitTime, "2026-09-27T12:00:00Z");
});
