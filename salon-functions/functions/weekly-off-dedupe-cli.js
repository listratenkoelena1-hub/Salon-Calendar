"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildWeeklyOffDedupePlan } = require("./weekly-off-dedupe-core");

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,40}$/;
const RULE_FIELDS = ["staffId", "weekday", "allDay", "enabled", "start", "end", "startDate", "endDate"];

function parseOptions(args) {
  const values = new Map();
  for (const arg of args) {
    if (!arg.startsWith("--")) throw new Error("All options must start with --.");
    const equalsAt = arg.indexOf("=");
    const name = equalsAt < 0 ? arg.slice(2) : arg.slice(2, equalsAt);
    const value = equalsAt < 0 ? true : arg.slice(equalsAt + 1);
    if (values.has(name)) throw new Error(`Duplicate option --${name}.`);
    values.set(name, value);
  }
  const permitted = new Set([
    "project", "as-of", "dry-run", "apply", "confirm-project",
    "expect-groups", "expect-deletions"
  ]);
  for (const name of values.keys()) {
    if (!permitted.has(name)) throw new Error(`Unknown option --${name}.`);
  }
  const projectId = String(values.get("project") || "");
  const asOfDate = String(values.get("as-of") || new Date().toISOString().slice(0, 10));
  if (!PROJECT_PATTERN.test(projectId)) throw new Error("Specify --project=PROJECT_ID.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error("--as-of must be YYYY-MM-DD.");
  const apply = values.has("apply");
  if (apply && values.has("dry-run")) throw new Error("Choose either --apply or --dry-run.");
  const expectedGroups = values.has("expect-groups") ? Number(values.get("expect-groups")) : null;
  const expectedDeletions = values.has("expect-deletions") ? Number(values.get("expect-deletions")) : null;
  for (const [label, value] of [["groups", expectedGroups], ["deletions", expectedDeletions]]) {
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100)) {
      throw new Error(`--expect-${label} must be an integer from 0 to 100.`);
    }
  }
  return {
    projectId,
    asOfDate,
    apply,
    confirmProject: String(values.get("confirm-project") || ""),
    expectedGroups,
    expectedDeletions
  };
}

function assertApplyAuthorized(options, environment) {
  if (!options.apply) throw new Error("This is a dry run, not an apply request.");
  if (options.confirmProject !== options.projectId) {
    throw new Error("--confirm-project must exactly match --project.");
  }
  if (options.expectedGroups === null || options.expectedDeletions === null) {
    throw new Error("--expect-groups and --expect-deletions are required for apply.");
  }
  if (environment.WEEKLY_OFF_DEDUPE_ENABLE_WRITES !== "YES") {
    throw new Error("WEEKLY_OFF_DEDUPE_ENABLE_WRITES=YES is required for real deletes.");
  }
}

function decodeField(value) {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.booleanValue !== undefined) return value.booleanValue;
  return null;
}

function weeklyRuleFromRest(document) {
  const record = {
    id: String(document.name || "").split("/").pop(),
    name: String(document.name || ""),
    createTime: String(document.createTime || ""),
    updateTime: String(document.updateTime || "")
  };
  for (const field of RULE_FIELDS) record[field] = decodeField(document.fields?.[field]);
  return record;
}

function findFirebaseToolsRoot(environment) {
  const candidates = [
    environment.FIREBASE_TOOLS_ROOT,
    environment.APPDATA && path.join(environment.APPDATA, "npm", "node_modules", "firebase-tools"),
    path.join(__dirname, "node_modules", "firebase-tools")
  ].filter(Boolean);
  const root = candidates.find(candidate => fs.existsSync(path.join(candidate, "lib", "auth.js")));
  if (!root) throw new Error("Firebase CLI installation was not found for authentication.");
  return root;
}

async function getFirebaseCliAccessToken(environment) {
  const root = findFirebaseToolsRoot(environment);
  const auth = require(path.join(root, "lib", "auth"));
  const scopes = require(path.join(root, "lib", "scopes"));
  const account = auth.getGlobalDefaultAccount();
  if (!account?.tokens?.refresh_token) throw new Error("Firebase CLI login is required.");
  const tokens = await auth.getAccessToken(account.tokens.refresh_token, [scopes.CLOUD_PLATFORM]);
  if (!tokens?.access_token) throw new Error("Firebase CLI did not provide an access token.");
  return tokens.access_token;
}

async function listWeeklyOffViaRest({ projectId, accessToken, fetchImpl = fetch }) {
  const base = new URL(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/WeeklyOff`
  );
  base.searchParams.set("pageSize", "500");
  for (const field of RULE_FIELDS) base.searchParams.append("mask.fieldPaths", field);
  const rules = [];
  let pageToken = "";
  do {
    const url = new URL(base);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Firestore WeeklyOff list failed: HTTP ${response.status}.`);
    const body = await response.json();
    rules.push(...(body.documents || []).map(weeklyRuleFromRest));
    pageToken = String(body.nextPageToken || "");
  } while (pageToken);
  return rules;
}

function serializePlan(plan) {
  const serializeRule = rule => ({
    id: rule.id,
    createTime: rule.createTime,
    updateTime: rule.updateTime,
    staffId: rule.staffId,
    weekday: rule.weekday,
    allDay: rule.allDay === true,
    enabled: rule.enabled !== false,
    start: rule.start,
    end: rule.end,
    startDate: rule.startDate || null,
    endDate: rule.endDate || null
  });
  return {
    asOfDate: plan.asOfDate,
    groupCount: plan.groupCount,
    deletionCount: plan.deletionCount,
    groups: plan.groups.map(group => ({
      key: group.key,
      keep: serializeRule(group.keep),
      remove: group.remove.map(serializeRule)
    }))
  };
}

async function commitDeletes({ projectId, accessToken, rules, fetchImpl = fetch }) {
  if (!rules.length) return { commitTime: null };
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      writes: rules.map(rule => ({
        delete: rule.name,
        currentDocument: { updateTime: rule.updateTime }
      }))
    })
  });
  if (!response.ok) throw new Error(`Firestore atomic delete failed: HTTP ${response.status}.`);
  return response.json();
}

async function run(options, { environment = process.env, fetchImpl = fetch } = {}) {
  if (options.apply) assertApplyAuthorized(options, environment);
  const accessToken = await getFirebaseCliAccessToken(environment);
  const rules = await listWeeklyOffViaRest({
    projectId: options.projectId,
    accessToken,
    fetchImpl
  });
  const plan = buildWeeklyOffDedupePlan(rules, { asOfDate: options.asOfDate });
  const report = serializePlan(plan);
  if (!options.apply) return { mode: "dry-run", project: options.projectId, writes: 0, ...report };
  if (
    plan.groupCount !== options.expectedGroups ||
    plan.deletionCount !== options.expectedDeletions
  ) {
    throw new Error("WeeklyOff totals changed after review; no deletes were started.");
  }
  const removals = plan.groups.flatMap(group => group.remove);
  const result = await commitDeletes({
    projectId: options.projectId,
    accessToken,
    rules: removals,
    fetchImpl
  });
  return {
    mode: "apply",
    project: options.projectId,
    deleted: removals.length,
    commitTime: result.commitTime || null,
    ...report
  };
}

async function main(args = process.argv.slice(2), environment = process.env) {
  const options = parseOptions(args);
  const result = await run(options, { environment });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`${error.name}: WeeklyOff dedupe stopped. ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertApplyAuthorized,
  commitDeletes,
  listWeeklyOffViaRest,
  parseOptions,
  run,
  serializePlan,
  weeklyRuleFromRest
};
