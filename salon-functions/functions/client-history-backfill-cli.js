"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  classifyBackfillAppointment,
  migrateLegacyAppointmentInTransaction,
  summarizeBackfillAppointments
} = require("./client-history-backfill-core");

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,40}$/;
const AUDIT_FIELDS = [
  "phone",
  "client",
  "source",
  "type",
  "status",
  "privacySchemaVersion",
  "hasPrivateContact"
];

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
    "project", "dry-run", "apply", "confirm-project", "rules-verified",
    "backend-verified", "limit"
  ]);
  for (const name of values.keys()) {
    if (!permitted.has(name)) throw new Error(`Unknown option --${name}.`);
  }
  const projectId = String(values.get("project") || "");
  if (!PROJECT_PATTERN.test(projectId)) throw new Error("Specify --project=PROJECT_ID.");
  const apply = values.has("apply");
  if (apply && values.has("dry-run")) throw new Error("Choose either --apply or --dry-run.");
  if (values.get("apply") !== undefined && values.get("apply") !== true) {
    throw new Error("--apply must not have a value.");
  }
  const limit = values.has("limit") ? Number(values.get("limit")) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 10000)) {
    throw new Error("--limit must be an integer between 1 and 10000.");
  }
  if (limit !== null && !apply) throw new Error("--limit is only available with --apply.");
  return {
    projectId,
    apply,
    confirmProject: String(values.get("confirm-project") || ""),
    rulesVerified: values.get("rules-verified") === true,
    backendVerified: values.get("backend-verified") === true,
    limit
  };
}

function assertApplyAuthorized(options, environment) {
  if (!options.apply) throw new Error("This is a dry run, not an apply request.");
  if (options.confirmProject !== options.projectId) {
    throw new Error("--confirm-project must exactly match --project.");
  }
  if (!options.rulesVerified || !options.backendVerified) {
    throw new Error("Protected Rules and the private-contact backend must be verified first.");
  }
  if (environment.BOOKING_BACKFILL_ENABLE_WRITES !== "YES") {
    throw new Error("BOOKING_BACKFILL_ENABLE_WRITES=YES is required for real writes.");
  }
  if (!String(environment.CLIENT_LOOKUP_PEPPER || "").trim()) {
    throw new Error("CLIENT_LOOKUP_PEPPER is required for phone identity reuse.");
  }
}

function decodeDocumentField(fields, name) {
  const value = fields?.[name];
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.booleanValue !== undefined) return value.booleanValue;
  return null;
}

function appointmentFromRestDocument(document) {
  const fields = document.fields || {};
  const result = { id: String(document.name || "").split("/").pop() };
  for (const field of AUDIT_FIELDS) result[field] = decodeDocumentField(fields, field);
  return result;
}

async function listAppointmentsViaRest({ projectId, accessToken, fetchImpl = fetch }) {
  const base = new URL(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/appointments`
  );
  base.searchParams.set("pageSize", "500");
  for (const field of AUDIT_FIELDS) base.searchParams.append("mask.fieldPaths", field);
  const appointments = [];
  const ids = new Set();
  let pageToken = "";
  let pageCount = 0;
  do {
    const url = new URL(base);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw new Error(`Firestore list failed: HTTP ${response.status}.`);
    const body = await response.json();
    pageCount += 1;
    if (pageCount > 200) throw new Error("Firestore audit exceeded 200 pages.");
    for (const document of body.documents || []) {
      const appointment = appointmentFromRestDocument(document);
      if (!appointment.id || ids.has(appointment.id)) {
        throw new Error("Firestore audit returned a missing or repeated appointment ID.");
      }
      ids.add(appointment.id);
      appointments.push(appointment);
    }
    pageToken = String(body.nextPageToken || "");
  } while (pageToken);
  return appointments;
}

async function countAppointmentsViaRest({ projectId, accessToken, fetchImpl = fetch }) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runAggregationQuery`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery: { from: [{ collectionId: "appointments" }] },
        aggregations: [{ alias: "total", count: {} }]
      }
    })
  });
  if (!response.ok) throw new Error(`Firestore count failed: HTTP ${response.status}.`);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : [body];
  const value = rows.find(row => row.result?.aggregateFields?.total)?.result.aggregateFields.total.integerValue;
  if (value === undefined) throw new Error("Firestore count returned no total.");
  return Number(value);
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
  if (!account?.tokens?.refresh_token) {
    throw new Error("Firebase CLI login is required for the dry run.");
  }
  const tokens = await auth.getAccessToken(account.tokens.refresh_token, [scopes.CLOUD_PLATFORM]);
  if (!tokens?.access_token) throw new Error("Firebase CLI did not provide an access token.");
  return tokens.access_token;
}

async function runDryRun(options, { environment = process.env, fetchImpl = fetch } = {}) {
  const accessToken = await getFirebaseCliAccessToken(environment);
  const appointments = await listAppointmentsViaRest({
    projectId: options.projectId,
    accessToken,
    fetchImpl
  });
  const independentTotal = await countAppointmentsViaRest({
    projectId: options.projectId,
    accessToken,
    fetchImpl
  });
  if (appointments.length !== independentTotal) {
    throw new Error("The read-only listing and independent count disagree; retry the audit.");
  }
  return {
    mode: "dry-run",
    project: options.projectId,
    writes: 0,
    ...summarizeBackfillAppointments(appointments)
  };
}

async function verifyMigratedAppointment(db, appointmentId) {
  const [publicSnapshot, privateSnapshot, historySnapshot] = await db.getAll(
    db.collection("appointments").doc(appointmentId),
    db.collection("appointmentPrivate").doc(appointmentId),
    db.collection("clientAppointmentHistory").doc(appointmentId)
  );
  const publicData = publicSnapshot.exists ? publicSnapshot.data() || {} : {};
  const privateData = privateSnapshot.exists ? privateSnapshot.data() || {} : {};
  const historyData = historySnapshot.exists ? historySnapshot.data() || {} : {};
  if (
    !publicSnapshot.exists || !privateSnapshot.exists || !historySnapshot.exists ||
    publicData.privacySchemaVersion !== 1 || publicData.hasPrivateContact !== true ||
    publicData.phone || publicData.phoneLookup ||
    !privateData.clientId || !privateData.clientProfileId ||
    historyData.clientId !== privateData.clientId ||
    historyData.clientProfileId !== privateData.clientProfileId ||
    String(publicData.source || "calendar") !== String(historyData.source || "") ||
    String(privateData.source || "") !== String(historyData.source || "")
  ) {
    throw new Error("Post-migration verification failed for one appointment.");
  }
}

async function runApply(options, { environment = process.env } = {}) {
  assertApplyAuthorized(options, environment);
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    const emulatorOnly = Boolean(environment.FIRESTORE_EMULATOR_HOST) &&
      options.projectId.startsWith("demo-");
    admin.initializeApp(emulatorOnly
      ? { projectId: options.projectId }
      : {
        credential: admin.credential.applicationDefault(),
        projectId: options.projectId
      });
  }
  if (admin.app().options.projectId !== options.projectId) {
    throw new Error("The initialized Admin SDK project differs from --project.");
  }
  const db = admin.firestore();
  const snapshot = await db.collection("appointments").select(...AUDIT_FIELDS).get();
  const appointments = snapshot.docs.map(document => ({ id: document.id, ...document.data() }));
  const before = summarizeBackfillAppointments(appointments);
  if (before.invalidPhone || before.missingName || before.inconsistentPublicPhone) {
    throw new Error("Audit found records needing manual review; no writes were started.");
  }
  const candidates = appointments
    .filter(appointment => classifyBackfillAppointment(appointment).status === "candidate")
    .sort((left, right) => left.id.localeCompare(right.id));
  const selected = options.limit === null ? candidates : candidates.slice(0, options.limit);
  if (selected.length) {
    const relatedSnapshots = await db.getAll(...selected.flatMap(appointment => [
      db.collection("appointmentPrivate").doc(appointment.id),
      db.collection("clientAppointmentHistory").doc(appointment.id)
    ]));
    if (relatedSnapshots.some(related => related.exists)) {
      throw new Error("Preflight found unexpected private records; no writes were started.");
    }
  }
  const result = {
    mode: "apply",
    project: options.projectId,
    candidatesSelected: selected.length,
    migrated: 0,
    alreadyVersioned: 0,
    skippedAfterRecheck: 0,
    createdPhoneClients: 0,
    createdNameProfiles: 0,
    verified: 0
  };
  for (const appointment of selected) {
    const outcome = await db.runTransaction(transaction => migrateLegacyAppointmentInTransaction({
      transaction,
      db,
      FieldValue: admin.firestore.FieldValue,
      appointmentId: appointment.id,
      pepper: environment.CLIENT_LOOKUP_PEPPER
    }));
    if (outcome.status === "migrated") {
      result.migrated += 1;
      if (outcome.createdClient) result.createdPhoneClients += 1;
      if (outcome.createdProfile) result.createdNameProfiles += 1;
    } else if (outcome.status === "already-versioned") {
      result.alreadyVersioned += 1;
    } else {
      result.skippedAfterRecheck += 1;
    }
    if (["migrated", "already-versioned"].includes(outcome.status)) {
      await verifyMigratedAppointment(db, appointment.id);
      result.verified += 1;
    }
  }
  return result;
}

async function main(args = process.argv.slice(2), environment = process.env) {
  const options = parseOptions(args);
  const result = options.apply
    ? await runApply(options, { environment })
    : await runDryRun(options, { environment });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    const safeMessages = [
      "Audit found records needing manual review; no writes were started.",
      "The read-only listing and independent count disagree; retry the audit.",
      "Post-migration verification failed for one appointment."
    ];
    console.error(safeMessages.includes(error.message) ? error.message : `${error.name}: backfill stopped.`);
    process.exitCode = 1;
  });
}

module.exports = {
  appointmentFromRestDocument,
  assertApplyAuthorized,
  countAppointmentsViaRest,
  decodeDocumentField,
  listAppointmentsViaRest,
  parseOptions,
  runApply,
  runDryRun,
  verifyMigratedAppointment
};
