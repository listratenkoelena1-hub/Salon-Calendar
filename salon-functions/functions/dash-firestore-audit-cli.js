"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  appointmentToDashBlock,
  offWorkToDashBlock
} = require("./dash-sync-core");
const { dedupeWeeklyOffRules } = require("./weekly-off-dedupe-core");

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,40}$/;

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
  for (const name of values.keys()) {
    if (!["project", "date"].includes(name)) throw new Error(`Unknown option --${name}.`);
  }
  const projectId = String(values.get("project") || "");
  const date = String(values.get("date") || "");
  if (!PROJECT_PATTERN.test(projectId)) throw new Error("Specify --project=PROJECT_ID.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Specify --date=YYYY-MM-DD.");
  return { projectId, date };
}

function decodeFirestoreValue(value) {
  if (!value) return null;
  if (value.nullValue !== undefined) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return Number(value.doubleValue);
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.arrayValue !== undefined) {
    return (value.arrayValue.values || []).map(decodeFirestoreValue);
  }
  if (value.mapValue !== undefined) {
    return decodeFirestoreFields(value.mapValue.fields || {});
  }
  return null;
}

function decodeFirestoreFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, value]) => (
    [key, decodeFirestoreValue(value)]
  )));
}

function documentFromRest(document) {
  return {
    id: String(document?.name || "").split("/").pop(),
    ...decodeFirestoreFields(document?.fields || {}),
    __createTime: String(document?.createTime || ""),
    __updateTime: String(document?.updateTime || "")
  };
}

function findFirebaseToolsRoot(environment) {
  const candidates = [
    environment.FIREBASE_TOOLS_ROOT,
    environment.APPDATA && path.join(environment.APPDATA, "npm", "node_modules", "firebase-tools"),
    path.join(__dirname, "node_modules", "firebase-tools")
  ].filter(Boolean);
  const root = candidates.find(candidate => fs.existsSync(path.join(candidate, "lib", "auth.js")));
  if (!root) throw new Error("Firebase CLI installation was not found for read-only authentication.");
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

async function runDateQuery({ projectId, accessToken, collectionId, date, fetchImpl = fetch }) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          fieldFilter: {
            field: { fieldPath: "date" },
            op: "EQUAL",
            value: { stringValue: date }
          }
        }
      }
    })
  });
  if (!response.ok) throw new Error(`Firestore ${collectionId} query failed: HTTP ${response.status}.`);
  const rows = await response.json();
  return (Array.isArray(rows) ? rows : [rows])
    .filter(row => row.document)
    .map(row => documentFromRest(row.document));
}

async function listCollection({ projectId, accessToken, collectionId, fetchImpl = fetch }) {
  const base = new URL(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collectionId}`
  );
  base.searchParams.set("pageSize", "500");
  const records = [];
  let pageToken = "";
  do {
    const url = new URL(base);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`Firestore ${collectionId} list failed: HTTP ${response.status}.`);
    const body = await response.json();
    records.push(...(body.documents || []).map(documentFromRest));
    pageToken = String(body.nextPageToken || "");
  } while (pageToken);
  return records;
}

function weekdayForDate(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function weeklyRuleActiveOnDate(rule, date) {
  if (rule.enabled === false || Number(rule.weekday) !== weekdayForDate(date)) return false;
  if (rule.startDate && date < rule.startDate) return false;
  if (rule.endDate && date > rule.endDate) return false;
  return true;
}

function makeWeeklyOccurrence(rule, date) {
  return {
    id: `weekly_${rule.id}_${date}`,
    date,
    staffId: rule.staffId,
    allDay: rule.allDay === true,
    start: rule.allDay === true ? null : Number(rule.start),
    end: rule.allDay === true ? null : Number(rule.end),
    weeklyRuleId: rule.id
  };
}

function safeAppointment(record, staffName, desired) {
  return {
    id: record.id,
    client: String(record.client || ""),
    staffId: String(record.staffId || ""),
    staffName,
    start: Number(record.start),
    duration: Number(record.duration),
    note: String(record.note || ""),
    selectedServices: Array.isArray(record.selectedServices) ? record.selectedServices : [],
    source: String(record.source || "calendar"),
    type: String(record.type || ""),
    status: String(record.status || ""),
    canceled: record.canceled === true,
    noShow: record.noShow === true,
    desired
  };
}

function safeOffWork(record, staffName, desired, kind) {
  return {
    id: record.id,
    kind,
    staffId: String(record.staffId || ""),
    staffName,
    allDay: record.allDay === true,
    start: record.allDay === true ? null : Number(record.start),
    end: record.allDay === true ? null : Number(record.end),
    desired
  };
}

async function run(options, { environment = process.env, fetchImpl = fetch } = {}) {
  const accessToken = await getFirebaseCliAccessToken(environment);
  const [appointments, offWork, weeklyRulesRaw, staffRaw, mappingRaw] = await Promise.all([
    runDateQuery({ ...options, accessToken, collectionId: "appointments", fetchImpl }),
    runDateQuery({ ...options, accessToken, collectionId: "OffWork", fetchImpl }),
    listCollection({ ...options, accessToken, collectionId: "WeeklyOff", fetchImpl }),
    listCollection({ ...options, accessToken, collectionId: "staff", fetchImpl }),
    listCollection({ ...options, accessToken, collectionId: "dashStaffMappings", fetchImpl })
  ]);
  const staff = [{ id: "anyone", name: "Anyone", active: true }, ...staffRaw];
  const staffById = new Map(staff.map(item => [String(item.id), item]));
  const mappings = Object.fromEntries(mappingRaw.map(item => [
    String(item.localStaffId || item.id),
    item
  ]));
  const weeklyDedupe = dedupeWeeklyOffRules(weeklyRulesRaw, { asOfDate: options.date });
  const exceptionIds = new Set(offWork
    .filter(item => item.weeklyException === true && item.weeklyId)
    .map(item => String(item.weeklyId)));
  const weeklyOccurrences = weeklyDedupe.records
    .filter(rule => weeklyRuleActiveOnDate(rule, options.date) && !exceptionIds.has(String(rule.id)))
    .map(rule => makeWeeklyOccurrence(rule, options.date));

  const appointmentRows = appointments.map(record => {
    const staffRecord = staffById.get(String(record.staffId)) || null;
    return safeAppointment(
      record,
      String(staffRecord?.name || staffRecord?.displayName || "Unknown"),
      appointmentToDashBlock(record, staffRecord, mappings)
    );
  });
  const offWorkRows = offWork
    .filter(record => record.weeklyException !== true)
    .map(record => {
      const staffRecord = staffById.get(String(record.staffId)) || null;
      return safeOffWork(
        record,
        String(staffRecord?.name || staffRecord?.displayName || "Unknown"),
        offWorkToDashBlock(record, staffRecord, mappings),
        "manual"
      );
    });
  const weeklyRows = weeklyOccurrences.map(record => {
    const staffRecord = staffById.get(String(record.staffId)) || null;
    return safeOffWork(
      record,
      String(staffRecord?.name || staffRecord?.displayName || "Unknown"),
      offWorkToDashBlock(record, staffRecord, mappings),
      "weekly"
    );
  });

  return {
    mode: "read_only",
    project: options.projectId,
    date: options.date,
    writes: 0,
    counts: {
      appointments: appointmentRows.length,
      offWorkDocuments: offWork.length,
      manualOffWork: offWorkRows.length,
      weeklyRuleDocuments: weeklyRulesRaw.length,
      activeWeeklyOccurrences: weeklyRows.length,
      duplicateWeeklyRules: weeklyDedupe.plan.deletionCount,
      staff: staffRaw.length,
      explicitDashMappings: mappingRaw.length
    },
    appointments: appointmentRows,
    offWork: offWorkRows,
    weeklyOff: weeklyRows
  };
}

async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const report = await run(options);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`${error.name}: one-day Firestore audit stopped. ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  decodeFirestoreFields,
  decodeFirestoreValue,
  documentFromRest,
  getFirebaseCliAccessToken,
  parseOptions,
  run
};
