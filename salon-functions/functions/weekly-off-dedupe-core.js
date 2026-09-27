"use strict";

const OPEN_START = "0000-01-01";
const OPEN_END = "9999-12-31";

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return Number(value.toMillis()) || 0;
  if (value instanceof Date) return value.getTime() || 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function weeklyRuleKey(rule) {
  if (!rule?.staffId || !Number.isInteger(Number(rule.weekday))) return "";
  const allDay = rule.allDay === true;
  const start = allDay ? "all" : Number(rule.start);
  const end = allDay ? "all" : Number(rule.end);
  if (!allDay && (!Number.isInteger(start) || !Number.isInteger(end) || end <= start)) return "";
  return [String(rule.staffId), Number(rule.weekday), allDay ? 1 : 0, start, end].join("|");
}

function effectiveRange(rule, asOfDate) {
  if (rule?.enabled === false) return null;
  const startDate = isIsoDate(rule?.startDate) ? String(rule.startDate) : OPEN_START;
  const endDate = isIsoDate(rule?.endDate) ? String(rule.endDate) : OPEN_END;
  const start = startDate > asOfDate ? startDate : asOfDate;
  if (endDate < start) return null;
  return { start, end: endDate };
}

function rangesOverlap(left, right) {
  return left.start <= right.end && right.start <= left.end;
}

function compareNewest(left, right) {
  const created = timestampMillis(right.createTime || right.__createTime) -
    timestampMillis(left.createTime || left.__createTime);
  if (created) return created;
  const updated = timestampMillis(right.updateTime || right.__updateTime) -
    timestampMillis(left.updateTime || left.__updateTime);
  if (updated) return updated;
  return String(right.id || "").localeCompare(String(left.id || ""));
}

function buildWeeklyOffDedupePlan(records, { asOfDate } = {}) {
  const asOf = isIsoDate(asOfDate) ? String(asOfDate) : new Date().toISOString().slice(0, 10);
  const keyed = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const key = weeklyRuleKey(record);
    const range = key ? effectiveRange(record, asOf) : null;
    if (!key || !range) continue;
    const group = keyed.get(key) || [];
    group.push({ record, range });
    keyed.set(key, group);
  }

  const groups = [];
  for (const [key, entries] of keyed.entries()) {
    const pending = entries.slice();
    while (pending.length) {
      const component = [pending.shift()];
      for (let changed = true; changed;) {
        changed = false;
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          if (!component.some(item => rangesOverlap(item.range, pending[index].range))) continue;
          component.push(pending.splice(index, 1)[0]);
          changed = true;
        }
      }
      if (component.length < 2) continue;
      const ordered = component.map(item => item.record).sort(compareNewest);
      groups.push({
        key,
        keep: ordered[0],
        remove: ordered.slice(1),
        overlappingRuleIds: ordered.map(rule => String(rule.id || ""))
      });
    }
  }

  groups.sort((left, right) => left.key.localeCompare(right.key));
  return {
    asOfDate: asOf,
    groupCount: groups.length,
    deletionCount: groups.reduce((total, group) => total + group.remove.length, 0),
    groups
  };
}

function dedupeWeeklyOffRules(records, { asOfDate } = {}) {
  const plan = buildWeeklyOffDedupePlan(records, { asOfDate });
  const removed = new Set(plan.groups.flatMap(group => group.remove.map(rule => String(rule.id || ""))));
  return {
    records: (Array.isArray(records) ? records : []).filter(rule => !removed.has(String(rule.id || ""))),
    plan
  };
}

module.exports = {
  buildWeeklyOffDedupePlan,
  compareNewest,
  dedupeWeeklyOffRules,
  effectiveRange,
  timestampMillis,
  weeklyRuleKey
};
