"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildWeeklyOffDedupePlan,
  dedupeWeeklyOffRules,
  weeklyRuleKey
} = require("./weekly-off-dedupe-core");

test("keeps the newest overlapping weekly rule and removes the older copy", () => {
  const records = [
    {
      id: "old",
      staffId: "inna",
      weekday: 0,
      allDay: true,
      enabled: true,
      createTime: "2026-02-01T00:00:00Z"
    },
    {
      id: "new",
      staffId: "inna",
      weekday: 0,
      allDay: true,
      enabled: true,
      startDate: "2026-03-15",
      createTime: "2026-03-10T00:00:00Z"
    }
  ];
  const plan = buildWeeklyOffDedupePlan(records, { asOfDate: "2026-09-27" });

  assert.equal(plan.groupCount, 1);
  assert.equal(plan.deletionCount, 1);
  assert.equal(plan.groups[0].keep.id, "new");
  assert.deepEqual(plan.groups[0].remove.map(rule => rule.id), ["old"]);
  assert.deepEqual(dedupeWeeklyOffRules(records, { asOfDate: "2026-09-27" }).records.map(rule => rule.id), ["new"]);
});

test("does not merge sequential rules whose active date ranges do not overlap", () => {
  const records = [
    {
      id: "past",
      staffId: "olha",
      weekday: 6,
      allDay: false,
      start: 8,
      end: 12,
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      createTime: "2026-01-01T00:00:00Z"
    },
    {
      id: "future",
      staffId: "olha",
      weekday: 6,
      allDay: false,
      start: 8,
      end: 12,
      startDate: "2026-07-01",
      createTime: "2026-06-15T00:00:00Z"
    }
  ];
  const plan = buildWeeklyOffDedupePlan(records, { asOfDate: "2026-01-01" });
  assert.equal(plan.groupCount, 0);
  assert.equal(weeklyRuleKey(records[0]), weeklyRuleKey(records[1]));
});

test("uses update time and then document id only when createTime is unavailable", () => {
  const base = {
    staffId: "inna",
    weekday: 3,
    allDay: false,
    start: 0,
    end: 17
  };
  const plan = buildWeeklyOffDedupePlan([
    { ...base, id: "a", updateTime: "2026-03-01T00:00:00Z" },
    { ...base, id: "b", updateTime: "2026-04-01T00:00:00Z" }
  ], { asOfDate: "2026-09-27" });
  assert.equal(plan.groups[0].keep.id, "b");
});
