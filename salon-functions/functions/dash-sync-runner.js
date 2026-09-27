"use strict";

const {
  appointmentToDashBlock,
  buildDashAppointment,
  buildDashStaffMessage,
  buildQueueId,
  findDashRequestConflict,
  getDashRequestDocumentId,
  minutesToTime,
  offWorkToDashBlock,
  resolveDashStaff,
  resolveLocalStaffForDashName
} = require("./dash-sync-core");
const { buildDashAuditPlan } = require("./dash-audit-core");
const {
  buildScheduleSlots,
  cloneSlots,
  getScheduleId,
  releaseAppointmentFromSlots,
  reserveAppointmentSlots
} = require("./appointment-schedule");
const {
  createAuthenticatedDashPage,
  createDashBrowserClient,
  launchDashBrowser
} = require("./dash-browser");

const ANYONE_ID = "anyone";
const DASH_QUEUE_COLLECTION = "dashSyncQueue";
const DASH_LINK_COLLECTION = "dashSyncLinks";
const DASH_RECEIPT_COLLECTION = "dashIncomingReceipts";
const DASH_RUN_COLLECTION = "dashSyncRuns";
const DASH_CONFIG_COLLECTION = "dashSyncConfig";
const DASH_MAPPING_COLLECTION = "dashStaffMappings";
const DASH_ISSUE_COLLECTION = "dashSyncIssues";
const DASH_AUDIT_COLLECTION = "dashSyncAudits";
const APPOINTMENT_SCHEDULE_COLLECTION = "appointmentSchedules";
const STAFF_MESSAGE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const DEFAULT_HORIZON_DAYS = 30;
const DEFAULT_QUEUE_LIMIT = 25;

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function sanitizeError(error) {
  return String(error?.message || error || "Unknown Dash sync error")
    .replace(/password|secret|credential/gi, "protected value")
    .slice(0, 500);
}

function isTerminalIncomingStatus(value) {
  return [
    "imported",
    "canceled",
    "rescheduled",
    "conflict",
    "duplicate",
    "baseline",
    "baseline_parse_error"
  ].includes(String(value || ""));
}

function buildDefaultConfig(raw = {}) {
  return {
    enabled: raw.enabled === true,
    writeEnabled: raw.writeEnabled === true,
    inboundEnabled: raw.inboundEnabled === true,
    inboundBaselineComplete: raw.inboundBaselineComplete === true,
    initialApplyEnabled: raw.initialApplyEnabled === true,
    dailyReconciliationEnabled: raw.dailyReconciliationEnabled !== false,
    horizonDays: clampInteger(raw.horizonDays, 1, 30, DEFAULT_HORIZON_DAYS),
    queueLimit: clampInteger(raw.queueLimit, 1, 50, DEFAULT_QUEUE_LIMIT)
  };
}

function dashCycleNeedsBrowser(config, hasPendingQueue) {
  return config.inboundEnabled === true || (
    config.writeEnabled === true && hasPendingQueue === true
  );
}

function getDashPollingWindow(date = new Date(), timeZone = "America/Edmonton") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const morningReconciliation = hour === 6 && minute === 0;
  const morningHourly = hour >= 6 && hour < 9 && minute === 0;
  const businessQuarterHour = (
    (hour >= 9 && hour < 19 && minute % 15 === 0) ||
    (hour === 19 && minute === 0)
  );
  const shouldRun = morningHourly || businessQuarterHour;

  return {
    shouldRun,
    morningReconciliation,
    hour,
    minute,
    phase: morningReconciliation
      ? "morning_reconciliation"
      : morningHourly
        ? "morning_hourly"
        : businessQuarterHour
          ? "business_quarter_hour"
          : "closed"
  };
}

async function loadDashConfig(db) {
  const snapshot = await db.collection(DASH_CONFIG_COLLECTION).doc("runtime").get();
  return buildDefaultConfig(snapshot.exists ? snapshot.data() : {});
}

async function loadDashMappings(db) {
  const snapshot = await db.collection(DASH_MAPPING_COLLECTION).get();
  const mappings = {};
  snapshot.docs.forEach(docSnap => {
    const data = docSnap.data() || {};
    const localStaffId = String(data.localStaffId || docSnap.id || "").trim();
    if (!localStaffId) return;
    mappings[localStaffId] = data;
  });
  return mappings;
}

async function loadLocalStaff(db, staffId) {
  if (staffId === ANYONE_ID) return { id: ANYONE_ID, name: "Anyone", active: true };
  if (!staffId) return null;
  const snapshot = await db.collection("staff").doc(staffId).get();
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

async function enqueueDashSource({
  db,
  FieldValue,
  sourceType,
  sourceId,
  before = null,
  after = null,
  localStaffOverride = undefined,
  mappingsOverride = undefined
}) {
  const effective = after || before || {};
  const localStaff = localStaffOverride === undefined
    ? await loadLocalStaff(db, effective.staffId)
    : localStaffOverride;
  const mappings = mappingsOverride === undefined
    ? await loadDashMappings(db)
    : mappingsOverride;
  const source = after ? { id: sourceId, ...after } : null;
  let desiredResult = sourceType === "off_work"
    ? offWorkToDashBlock(source, localStaff, mappings)
    : appointmentToDashBlock(source, localStaff, mappings);
  if (desiredResult.ok && source.date < dateKeyInTimeZone()) {
    desiredResult = { ok: false, reason: "historical-date" };
  }
  const queueRef = db.collection(DASH_QUEUE_COLLECTION).doc(buildQueueId(sourceType, sourceId));
  const issueRef = db.collection(DASH_ISSUE_COLLECTION).doc(queueRef.id);

  await db.runTransaction(async transaction => {
    const current = await transaction.get(queueRef);
    const version = Number(current.data()?.version || 0) + 1;
    transaction.set(queueRef, {
      sourceType,
      sourceId,
      date: String(effective.date || desiredResult.block?.date || ""),
      action: desiredResult.ok ? "upsert" : "delete",
      desired: desiredResult.ok ? desiredResult.block : null,
      reason: desiredResult.ok ? null : desiredResult.reason,
      status: "pending",
      attempts: 0,
      version,
      queuedAt: current.exists ? (current.data()?.queuedAt || FieldValue.serverTimestamp()) : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastError: FieldValue.delete(),
      lastAttemptAt: FieldValue.delete()
    }, { merge: true });

    if (["unmapped-staff", "missing-local-staff"].includes(desiredResult.reason)) {
      transaction.set(issueRef, {
        sourceType,
        sourceId,
        staffId: String(effective.staffId || ""),
        staffName: String(localStaff?.name || localStaff?.displayName || ""),
        reason: desiredResult.reason,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      transaction.delete(issueRef);
    }
  });

  return {
    queueId: queueRef.id,
    action: desiredResult.ok ? "upsert" : "delete",
    reason: desiredResult.ok ? null : desiredResult.reason
  };
}

async function recordQueueFailure({ db, FieldValue, queueRef, expectedVersion, error }) {
  await db.runTransaction(async transaction => {
    const current = await transaction.get(queueRef);
    if (!current.exists || Number(current.data()?.version || 0) !== Number(expectedVersion)) return;
    transaction.set(queueRef, {
      status: "pending",
      attempts: FieldValue.increment(1),
      lastError: sanitizeError(error),
      lastAttemptAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

async function markQueueDryRun({ db, FieldValue, queueRef, expectedVersion, previewAction }) {
  await db.runTransaction(async transaction => {
    const current = await transaction.get(queueRef);
    if (!current.exists || Number(current.data()?.version || 0) !== Number(expectedVersion)) return;
    transaction.set(queueRef, {
      status: "dry_run",
      previewAction,
      previewedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

async function finishQueueItem({ db, queueRef, expectedVersion, linkRef, linkData = null }) {
  await db.runTransaction(async transaction => {
    const current = await transaction.get(queueRef);
    if (!current.exists) return;
    const versionMatches = Number(current.data()?.version || 0) === Number(expectedVersion);
    // The source may change while the browser is saving. Preserve the block
    // identity produced by this attempt even when the queue version advanced;
    // the newer pending version can then update/delete that exact block rather
    // than leaking an orphaned closure in Dash.
    if (linkRef && linkData) transaction.set(linkRef, linkData, { merge: true });
    if (linkRef && linkData === false) transaction.delete(linkRef);
    if (versionMatches) transaction.delete(queueRef);
  });
}

async function processDashQueue({ db, FieldValue, client, dryRun, limit = DEFAULT_QUEUE_LIMIT }) {
  const snapshot = await db.collection(DASH_QUEUE_COLLECTION)
    .where("status", "==", "pending")
    .orderBy("date", "asc")
    .limit(limit)
    .get();
  const report = { scanned: snapshot.size, created: 0, adopted: 0, updated: 0, recreated: 0, deleted: 0, noop: 0, failed: 0, dryRun: 0 };

  for (const queueDoc of snapshot.docs) {
    const queue = queueDoc.data() || {};
    const linkRef = db.collection(DASH_LINK_COLLECTION).doc(queueDoc.id);
    try {
      const linkSnap = await linkRef.get();
      const link = linkSnap.exists ? linkSnap.data() || {} : null;

      if (queue.action === "delete") {
        if (!link) {
          report.noop += 1;
          await finishQueueItem({ db, queueRef: queueDoc.ref, expectedVersion: queue.version });
          continue;
        }
        const result = await client.deleteBlock(link);
        if (result.dryRun) {
          report.dryRun += 1;
          await markQueueDryRun({
            db,
            FieldValue,
            queueRef: queueDoc.ref,
            expectedVersion: queue.version,
            previewAction: "delete"
          });
          continue;
        }
        report.deleted += 1;
        await finishQueueItem({
          db,
          queueRef: queueDoc.ref,
          expectedVersion: queue.version,
          linkRef,
          linkData: false
        });
        continue;
      }

      const desired = queue.desired;
      if (!desired?.fingerprint) {
        report.noop += 1;
        await finishQueueItem({ db, queueRef: queueDoc.ref, expectedVersion: queue.version });
        continue;
      }
      if (link?.fingerprint === desired.fingerprint) {
        report.noop += 1;
        await finishQueueItem({ db, queueRef: queueDoc.ref, expectedVersion: queue.version });
        continue;
      }

      const result = link
        ? await client.updateBlock(link, desired)
        : await client.createBlock(desired);
      if (result.dryRun || dryRun) {
        report.dryRun += 1;
        await markQueueDryRun({
          db,
          FieldValue,
          queueRef: queueDoc.ref,
          expectedVersion: queue.version,
          previewAction: result.action || (link ? "update" : "create")
        });
        continue;
      }

      const action = result.action || (link ? "updated" : "created");
      if (action === "created") report.created += 1;
      else if (action === "adopted") report.adopted += 1;
      else if (action === "recreated") report.recreated += 1;
      else report.updated += 1;
      await finishQueueItem({
        db,
        queueRef: queueDoc.ref,
        expectedVersion: queue.version,
        linkRef,
        linkData: {
          sourceType: queue.sourceType,
          sourceId: queue.sourceId,
          ...desired,
          dashBlockId: result.dashBlockId || link?.dashBlockId || "",
          editUrl: result.editUrl || link?.editUrl || "",
          syncedAt: FieldValue.serverTimestamp(),
          lastAction: action
        }
      });
    } catch (error) {
      report.failed += 1;
      await recordQueueFailure({
        db,
        FieldValue,
        queueRef: queueDoc.ref,
        expectedVersion: queue.version,
        error
      });
    }
  }
  return report;
}

function dateKeyInTimeZone(date = new Date(), timeZone = "America/Edmonton") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDateKeyDays(dateKey, days) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12));
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("-");
}

function minutesInTimeZone(date = new Date(), timeZone = "America/Edmonton") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

function blockEndsAfterMinute(block, minute) {
  if (!block?.end) return false;
  const match = String(block.end).match(/^(\d{2}):(\d{2})$/);
  if (!match) return false;
  return Number(match[1]) * 60 + Number(match[2]) > Number(minute);
}

function weekdayForDateKey(dateKey) {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

function weeklyRuleActiveOnDate(rule, dateKey) {
  if (rule.enabled === false || Number(rule.weekday) !== weekdayForDateKey(dateKey)) return false;
  if (rule.startDate && dateKey < rule.startDate) return false;
  if (rule.endDate && dateKey > rule.endDate) return false;
  return true;
}

function makeWeeklyOccurrence(rule, dateKey) {
  return {
    id: `weekly_${rule.id}_${dateKey}`,
    date: dateKey,
    staffId: rule.staffId,
    allDay: rule.allDay === true,
    start: rule.allDay === true ? null : Number(rule.start),
    end: rule.allDay === true ? null : Number(rule.end),
    weeklyRuleId: rule.id
  };
}

async function collectDashAuditState({
  db,
  startDate,
  endDate,
  now = new Date(),
  timeZone = "America/Edmonton"
}) {
  const [appointmentSnap, offWorkSnap, weeklySnap, staffSnap, mappings] = await Promise.all([
    db.collection("appointments").where("date", ">=", startDate).where("date", "<=", endDate).get(),
    db.collection("OffWork").where("date", ">=", startDate).where("date", "<=", endDate).get(),
    db.collection("WeeklyOff").get(),
    db.collection("staff").get(),
    loadDashMappings(db)
  ]);
  const staffRecords = [
    { id: ANYONE_ID, name: "Anyone", active: true },
    ...staffSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
  ];
  const staffById = new Map(staffRecords.map(staff => [staff.id, staff]));
  const localAppointments = appointmentSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
  const offWorkDocs = offWorkSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
  const desiredBlocks = [];
  const today = dateKeyInTimeZone(now, timeZone);
  const currentMinute = minutesInTimeZone(now, timeZone);

  const includeDesired = result => {
    if (!result?.ok) return;
    if (result.block.date === today && !blockEndsAfterMinute(result.block, currentMinute)) return;
    desiredBlocks.push(result.block);
  };

  for (const appointment of localAppointments) {
    includeDesired(appointmentToDashBlock(
      appointment,
      staffById.get(appointment.staffId) || null,
      mappings
    ));
  }
  for (const record of offWorkDocs) {
    if (record.weeklyException === true) continue;
    includeDesired(offWorkToDashBlock(
      record,
      staffById.get(record.staffId) || null,
      mappings
    ));
  }
  const exceptions = new Set(offWorkDocs
    .filter(record => record.weeklyException === true && record.weeklyId)
    .map(record => `${record.weeklyId}__${record.date}`));
  const weeklyRules = weeklySnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
  const days = Math.max(0, Math.round((Date.parse(`${endDate}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / 86400000));
  for (let offset = 0; offset <= days; offset += 1) {
    const date = addDateKeyDays(startDate, offset);
    for (const rule of weeklyRules) {
      if (!weeklyRuleActiveOnDate(rule, date)) continue;
      if (exceptions.has(`${rule.id}__${date}`)) continue;
      const occurrence = makeWeeklyOccurrence(rule, date);
      includeDesired(offWorkToDashBlock(
        occurrence,
        staffById.get(occurrence.staffId) || null,
        mappings
      ));
    }
  }
  const relevantAppointments = localAppointments.filter(appointment => {
    if (appointment.date !== today) return true;
    const endMinute = 8 * 60 + (Number(appointment.start) + Number(appointment.duration || 1)) * 15;
    return endMinute > currentMinute;
  });
  return {
    localAppointments: relevantAppointments,
    desiredBlocks,
    staffRecords,
    mappings,
    counts: {
      appointmentDocuments: appointmentSnap.size,
      offWorkDocuments: offWorkSnap.size,
      weeklyRules: weeklySnap.size
    }
  };
}

async function runDashAudit({
  db,
  FieldValue,
  client,
  startDate = dateKeyInTimeZone(),
  horizonDays = DEFAULT_HORIZON_DAYS,
  requestedBy = ""
}) {
  const safeHorizon = clampInteger(horizonDays, 1, 30, DEFAULT_HORIZON_DAYS);
  // horizonDays is an inclusive calendar-day count: 1 means startDate only.
  const endDate = addDateKeyDays(startDate, safeHorizon - 1);
  const now = new Date();
  const today = dateKeyInTimeZone(now);
  const currentMinute = minutesInTimeZone(now);
  const local = await collectDashAuditState({ db, startDate, endDate, now });
  const observed = await client.readCalendarRange({ startDate, endDate });
  const dashAppointments = observed.appointments.map(detail => {
    const localStaff = resolveLocalStaffForDashName(local.staffRecords, detail.staffName, local.mappings);
    const mapping = localStaff ? resolveDashStaff(localStaff, local.mappings) : null;
    return {
      ...detail,
      localStaffId: localStaff?.id || "",
      dashStaffId: mapping?.ok ? mapping.dashStaffId : ""
    };
  }).filter(detail => {
    if (detail.dashStatus === "canceled") return false;
    if (detail.date !== today) return true;
    return 8 * 60 + (Number(detail.start) + Number(detail.duration || 1)) * 15 > currentMinute;
  });
  const dashBlocks = observed.blocks.map(block => {
    const localStaff = resolveLocalStaffForDashName(local.staffRecords, block.dashStaffName, local.mappings);
    const mapping = localStaff ? resolveDashStaff(localStaff, local.mappings) : null;
    return {
      ...block,
      localStaffId: localStaff?.id || "",
      dashStaffId: mapping?.ok ? mapping.dashStaffId : ""
    };
  }).filter(block => block.date !== today || blockEndsAfterMinute(block, currentMinute));
  const plan = buildDashAuditPlan({
    startDate,
    endDate,
    localAppointments: local.localAppointments,
    desiredBlocks: local.desiredBlocks,
    dashAppointments,
    dashBlocks
  });
  const auditRef = db.collection(DASH_AUDIT_COLLECTION).doc();
  const report = {
    ...plan,
    auditId: auditRef.id,
    requestedBy: String(requestedBy || ""),
    createdAt: FieldValue.serverTimestamp(),
    completedAt: FieldValue.serverTimestamp(),
    status: "complete",
    readOnly: true,
    writesPerformed: 0,
    localCounts: local.counts,
    observedDays: observed.days
  };
  await auditRef.set(report);
  return { ...report, createdAt: null, completedAt: null };
}

async function runDashAuditWithBrowser({
  db,
  FieldValue,
  email,
  password,
  startDate,
  horizonDays = DEFAULT_HORIZON_DAYS,
  requestedBy = "",
  executablePath = ""
}) {
  if (!String(email || "").trim() || !String(password || "")) {
    throw new Error("Dash Booking protected sign-in values are not configured.");
  }
  const browser = await launchDashBrowser({ executablePath });
  try {
    const page = await createAuthenticatedDashPage(browser, { email, password });
    const client = createDashBrowserClient(page, { dryRun: true, auditSummaryOnly: true });
    return runDashAudit({
      db,
      FieldValue,
      client,
      startDate,
      horizonDays,
      requestedBy
    });
  } finally {
    await browser.close();
  }
}

async function enqueueDashReconciliation({
  db,
  FieldValue,
  horizonDays = DEFAULT_HORIZON_DAYS,
  today = dateKeyInTimeZone()
}) {
  const endDate = addDateKeyDays(today, horizonDays);
  const [appointmentSnap, offWorkSnap, weeklySnap, linkSnap, staffSnap, mappings] = await Promise.all([
    db.collection("appointments").where("date", ">=", today).where("date", "<=", endDate).get(),
    db.collection("OffWork").where("date", ">=", today).where("date", "<=", endDate).get(),
    db.collection("WeeklyOff").get(),
    db.collection(DASH_LINK_COLLECTION).where("date", ">=", today).where("date", "<=", endDate).get(),
    db.collection("staff").get(),
    loadDashMappings(db)
  ]);
  const desiredKeys = new Set();
  const jobs = [];
  const staffById = new Map(staffSnap.docs.map(docSnap => [
    docSnap.id,
    { id: docSnap.id, ...docSnap.data() }
  ]));
  staffById.set(ANYONE_ID, { id: ANYONE_ID, name: "Anyone", active: true });

  for (const docSnap of appointmentSnap.docs) {
    desiredKeys.add(buildQueueId("appointment", docSnap.id));
    jobs.push({
      sourceType: "appointment",
      sourceId: docSnap.id,
      after: docSnap.data()
    });
  }

  const offWorkDocs = offWorkSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
  for (const record of offWorkDocs) {
    if (record.weeklyException === true) continue;
    desiredKeys.add(buildQueueId("off_work", record.id));
    jobs.push({
      sourceType: "off_work",
      sourceId: record.id,
      after: record
    });
  }

  const exceptions = new Set(offWorkDocs
    .filter(record => record.weeklyException === true && record.weeklyId)
    .map(record => `${record.weeklyId}__${record.date}`));
  const weeklyRules = weeklySnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
  for (let offset = 0; offset <= horizonDays; offset += 1) {
    const dateKey = addDateKeyDays(today, offset);
    for (const rule of weeklyRules) {
      if (!weeklyRuleActiveOnDate(rule, dateKey)) continue;
      if (exceptions.has(`${rule.id}__${dateKey}`)) continue;
      const occurrence = makeWeeklyOccurrence(rule, dateKey);
      desiredKeys.add(buildQueueId("off_work", occurrence.id));
      jobs.push({
        sourceType: "off_work",
        sourceId: occurrence.id,
        after: occurrence
      });
    }
  }

  // Reconciliation can cover hundreds of future records. Reuse the same
  // staff/mapping snapshots and write in bounded parallel batches.
  for (let index = 0; index < jobs.length; index += 20) {
    await Promise.all(jobs.slice(index, index + 20).map(job => enqueueDashSource({
      db,
      FieldValue,
      ...job,
      localStaffOverride: staffById.get(job.after?.staffId) || null,
      mappingsOverride: mappings
    })));
  }

  let cleanupQueued = 0;
  for (const linkDoc of linkSnap.docs) {
    const link = linkDoc.data() || {};
    if (link.date && (link.date < today || link.date > endDate)) continue;
    if (desiredKeys.has(linkDoc.id)) continue;
    await db.collection(DASH_QUEUE_COLLECTION).doc(linkDoc.id).set({
      sourceType: link.sourceType || "appointment",
      sourceId: link.sourceId || "",
      date: String(link.date || ""),
      action: "delete",
      desired: null,
      reason: "reconciliation-source-missing",
      status: "pending",
      attempts: 0,
      version: Date.now(),
      queuedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    cleanupQueued += 1;
  }

  return {
    today,
    endDate,
    appointments: appointmentSnap.size,
    offWork: offWorkSnap.size,
    weeklyRules: weeklySnap.size,
    queued: jobs.length,
    cleanupQueued
  };
}

function getWeeklyOffOccurrencesForDate(records, date, staffId) {
  return records
    .filter(rule => rule.staffId === staffId && weeklyRuleActiveOnDate(rule, date))
    .map(rule => ({
      id: `weekly_${rule.id}_${date}`,
      date,
      staffId,
      allDay: rule.allDay === true,
      start: rule.allDay === true ? null : Number(rule.start),
      end: rule.allDay === true ? null : Number(rule.end)
    }));
}

function buildDashMessageDoc({
  FieldValue,
  Timestamp,
  message,
  eventType,
  entityType,
  entityId,
  staffId,
  staffName,
  staffRecords,
  conflict = false
}) {
  const audienceStaffIds = staffRecords
    .filter(staff => staff.active !== false && staff.id && staff.id !== ANYONE_ID)
    .map(staff => staff.id);
  const titles = {
    dash_appointment_added: "Dash Booking appointment",
    dash_appointment_canceled: "Dash Booking canceled",
    dash_appointment_rescheduled: "Dash Booking rescheduled",
    dash_appointment_conflict: "Dash Booking conflict"
  };
  return {
    recipientStaffId: "",
    recipientStaffName: "",
    visibleToManager: true,
    visibleToAllStaff: true,
    title: conflict ? "Dash Booking conflict" : (titles[eventType] || "Dash Booking appointment"),
    body: message,
    eventType,
    entityType,
    entityId,
    staffId: staffId || "",
    staffName: staffName || "",
    priority: "key",
    pushEligible: true,
    readBy: {},
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromDate(new Date(Date.now() + STAFF_MESSAGE_TTL_MS)),
    source: "dash_booking",
    messageGroupId: `dash-booking-${entityId}`,
    audienceVersion: 2,
    audienceStaffIds,
    importantStaffIds: staffId && staffId !== ANYONE_ID ? [staffId] : [],
    managerPriority: "key",
    staffDefaultPriority: "secondary",
    notificationLink: "https://rosesnails-calendar.web.app"
  };
}

function buildDashActivityLogDoc({ FieldValue, detail, eventType, entityType, entityId, staffId, message }) {
  return {
    createdAt: FieldValue.serverTimestamp(),
    logDate: detail.date,
    actorLabel: "DashBooking",
    actorKey: "dash_booking",
    staffId: staffId || "",
    eventType,
    entityType,
    entityId,
    client: detail.client,
    hasPrivateContact: false,
    service: detail.service,
    details: message
  };
}

function buildDashEventDocumentId(item, appointmentId) {
  const suffix = String(item?.notificationKey || "event").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  return `dash_${appointmentId}_${suffix || "event"}`;
}

async function findExistingDashAppointment(db, dashBookingId) {
  const deterministicId = getDashRequestDocumentId(dashBookingId);
  const deterministicRef = db.collection("appointments").doc(deterministicId);
  const deterministicSnap = await deterministicRef.get();
  if (deterministicSnap.exists) {
    return { ref: deterministicRef, id: deterministicId, data: deterministicSnap.data() || {} };
  }
  const snapshot = await db.collection("appointments")
    .where("dashBookingId", "==", String(dashBookingId || ""))
    .limit(2)
    .get();
  if (snapshot.size !== 1) {
    return { ref: null, id: "", data: null, ambiguous: snapshot.size > 1 };
  }
  const document = snapshot.docs[0];
  return { ref: document.ref, id: document.id, data: document.data() || {} };
}

async function recordDashEventProblem({
  db,
  FieldValue,
  Timestamp,
  item,
  detail,
  staffRecords,
  status,
  reason,
  appointmentId = "",
  staffId = ""
}) {
  const entityId = appointmentId || getDashRequestDocumentId(detail.dashBookingId);
  const eventDocumentId = buildDashEventDocumentId(item, entityId);
  const eventType = "dash_appointment_conflict";
  const message = [
    "DASH BOOKING CONFLICT",
    `${detail.client || "A client"}'s Dash appointment could not be updated automatically.`,
    `${detail.date || "Unknown date"}${detail.staffName ? ` · ${detail.staffName}` : ""}`,
    "",
    `Reason: ${reason}. Please resolve this appointment manually.`
  ].join("\n");
  const localStaff = staffRecords.find(staff => staff.id === staffId) || null;
  const batch = db.batch();
  batch.set(db.collection(DASH_RECEIPT_COLLECTION).doc(item.notificationKey), {
    notificationKey: item.notificationKey,
    dashBookingId: detail.dashBookingId,
    status,
    conflictReason: reason,
    appointmentId,
    processedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  batch.set(db.collection("staffMessages").doc(eventDocumentId), buildDashMessageDoc({
    FieldValue,
    Timestamp,
    message,
    eventType,
    entityType: "dashBooking",
    entityId,
    staffId,
    staffName: localStaff?.name || detail.staffName || "",
    staffRecords,
    conflict: true
  }));
  batch.set(db.collection("activityLog").doc(eventDocumentId), buildDashActivityLogDoc({
    FieldValue,
    detail,
    eventType,
    entityType: "dashBooking",
    entityId,
    staffId,
    message
  }));
  await batch.commit();
  return { status, appointmentId: appointmentId || null, reason };
}

async function cancelDashAppointment({ db, FieldValue, Timestamp, item, staffRecords }) {
  const detail = item.detail;
  if (!detail?.dashBookingId) return { status: "parse_error" };
  const existing = await findExistingDashAppointment(db, detail.dashBookingId);
  if (!existing.ref) {
    return recordDashEventProblem({
      db,
      FieldValue,
      Timestamp,
      item,
      detail,
      staffRecords,
      status: "conflict",
      reason: existing.ambiguous ? "multiple Rose appointments share this Dash ID" : "matching Rose appointment was not found"
    });
  }

  const eventDocumentId = buildDashEventDocumentId(item, existing.id);
  return db.runTransaction(async transaction => {
    const appointmentSnap = await transaction.get(existing.ref);
    if (!appointmentSnap.exists) return { status: "duplicate", appointmentId: existing.id };
    const appointment = { id: existing.id, ...appointmentSnap.data() };
    const scheduleRef = db.collection(APPOINTMENT_SCHEDULE_COLLECTION)
      .doc(getScheduleId(appointment.date, appointment.staffId));
    const scheduleSnap = await transaction.get(scheduleRef);
    const releasedSlots = scheduleSnap.exists
      ? releaseAppointmentFromSlots(scheduleSnap.data()?.slots, appointment, existing.id)
      : null;
    const detailWithStaff = {
      ...detail,
      date: appointment.date,
      start: appointment.start,
      duration: appointment.duration,
      client: appointment.client || detail.client,
      service: appointment.note || detail.service,
      staffId: appointment.staffId,
      staffName: detail.staffName || staffRecords.find(staff => staff.id === appointment.staffId)?.name || "technician"
    };
    const message = buildDashStaffMessage(detailWithStaff, { eventType: "dash_appointment_canceled" });

    if (releasedSlots) {
      transaction.set(scheduleRef, {
        schemaVersion: 1,
        date: appointment.date,
        staffId: appointment.staffId,
        slots: releasedSlots,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    transaction.set(existing.ref, {
      canceled: true,
      cancelComment: detail.cancellationReason
        ? `Dash Booking: ${detail.cancellationReason}`
        : "Canceled by client in Dash Booking",
      lastEditedBy: "DashBooking",
      lastAction: "dash_appointment_canceled",
      lastMutationMode: "dash_import",
      revision: Number(appointment.revision || 0) + 1,
      updatedAt: FieldValue.serverTimestamp(),
      lastActionAt: FieldValue.serverTimestamp(),
      dashObservedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(db.collection(DASH_RECEIPT_COLLECTION).doc(item.notificationKey), {
      notificationKey: item.notificationKey,
      dashBookingId: detail.dashBookingId,
      status: "canceled",
      appointmentId: existing.id,
      processedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(db.collection(DASH_RECEIPT_COLLECTION).doc(getDashRequestDocumentId(detail.dashBookingId)), {
      latestStatus: "canceled",
      latestNotificationKey: item.notificationKey,
      appointmentId: existing.id,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(db.collection("staffMessages").doc(eventDocumentId), buildDashMessageDoc({
      FieldValue,
      Timestamp,
      message,
      eventType: "dash_appointment_canceled",
      entityType: "appointment",
      entityId: existing.id,
      staffId: appointment.staffId,
      staffName: detailWithStaff.staffName,
      staffRecords
    }));
    transaction.set(db.collection("activityLog").doc(eventDocumentId), buildDashActivityLogDoc({
      FieldValue,
      detail: detailWithStaff,
      eventType: "dash_appointment_canceled",
      entityType: "appointment",
      entityId: existing.id,
      staffId: appointment.staffId,
      message
    }));
    return { status: "canceled", appointmentId: existing.id };
  });
}

async function rescheduleDashAppointment({ db, FieldValue, Timestamp, item, staffRecords, mappings }) {
  const detail = item.detail;
  if (!detail?.dashBookingId) return { status: "parse_error" };
  const existing = await findExistingDashAppointment(db, detail.dashBookingId);
  if (!existing.ref) {
    return recordDashEventProblem({
      db,
      FieldValue,
      Timestamp,
      item,
      detail,
      staffRecords,
      status: "conflict",
      reason: existing.ambiguous ? "multiple Rose appointments share this Dash ID" : "matching Rose appointment was not found"
    });
  }
  const localStaff = resolveLocalStaffForDashName(staffRecords, detail.staffName, mappings);
  if (!localStaff) {
    return recordDashEventProblem({
      db,
      FieldValue,
      Timestamp,
      item,
      detail,
      staffRecords,
      status: "conflict",
      reason: "Dash technician is not mapped",
      appointmentId: existing.id
    });
  }

  const eventDocumentId = buildDashEventDocumentId(item, existing.id);
  return db.runTransaction(async transaction => {
    const appointmentSnap = await transaction.get(existing.ref);
    if (!appointmentSnap.exists) return { status: "duplicate", appointmentId: existing.id };
    const appointment = { id: existing.id, ...appointmentSnap.data() };
    const detailWithStaff = { ...detail, staffId: localStaff.id };
    const [appointmentsSnap, offWorkSnap, weeklyOffSnap] = await Promise.all([
      transaction.get(db.collection("appointments").where("date", "==", detail.date)),
      transaction.get(db.collection("OffWork").where("date", "==", detail.date)),
      transaction.get(db.collection("WeeklyOff").where("staffId", "==", localStaff.id))
    ]);
    const appointments = appointmentsSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    const manualOffWork = offWorkSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    const weeklyOffRecords = weeklyOffSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    const weeklyExceptions = new Set(manualOffWork
      .filter(record => record.weeklyException === true && record.weeklyId)
      .map(record => record.weeklyId));
    const weeklyOccurrences = getWeeklyOffOccurrencesForDate(
      weeklyOffRecords.filter(rule => !weeklyExceptions.has(rule.id)),
      detail.date,
      localStaff.id
    );
    const conflict = findDashRequestConflict({
      detail: detailWithStaff,
      appointments,
      offWork: manualOffWork.concat(weeklyOccurrences)
    });
    if (conflict.conflict) {
      const message = buildDashStaffMessage(detailWithStaff, { conflict });
      transaction.set(db.collection(DASH_RECEIPT_COLLECTION).doc(item.notificationKey), {
        notificationKey: item.notificationKey,
        dashBookingId: detail.dashBookingId,
        status: "conflict",
        conflictReason: conflict.reason,
        appointmentId: existing.id,
        processedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(db.collection("staffMessages").doc(eventDocumentId), buildDashMessageDoc({
        FieldValue,
        Timestamp,
        message,
        eventType: "dash_appointment_conflict",
        entityType: "appointment",
        entityId: existing.id,
        staffId: localStaff.id,
        staffName: localStaff.name || detail.staffName,
        staffRecords,
        conflict: true
      }));
      transaction.set(db.collection("activityLog").doc(eventDocumentId), buildDashActivityLogDoc({
        FieldValue,
        detail: detailWithStaff,
        eventType: "dash_appointment_conflict",
        entityType: "appointment",
        entityId: existing.id,
        staffId: localStaff.id,
        message
      }));
      return { status: "conflict", appointmentId: existing.id, reason: conflict.reason };
    }

    const oldScheduleRef = db.collection(APPOINTMENT_SCHEDULE_COLLECTION)
      .doc(getScheduleId(appointment.date, appointment.staffId));
    const newScheduleRef = db.collection(APPOINTMENT_SCHEDULE_COLLECTION)
      .doc(getScheduleId(detail.date, localStaff.id));
    const sameSchedule = oldScheduleRef.path === newScheduleRef.path;
    const oldScheduleSnap = await transaction.get(oldScheduleRef);
    const newScheduleSnap = sameSchedule ? oldScheduleSnap : await transaction.get(newScheduleRef);
    const oldSlots = releaseAppointmentFromSlots(oldScheduleSnap.data()?.slots, appointment, existing.id);
    const newBaseSlots = sameSchedule
      ? oldSlots
      : releaseAppointmentFromSlots(
          newScheduleSnap.exists
            ? newScheduleSnap.data()?.slots
            : buildScheduleSlots(appointments, { date: detail.date, staffId: localStaff.id, anyoneId: ANYONE_ID }),
          appointment,
          existing.id
        );
    const updatedAppointment = buildDashAppointment(detailWithStaff, localStaff);
    let newSlots;
    try {
      newSlots = reserveAppointmentSlots(newBaseSlots, updatedAppointment, existing.id);
    } catch (_error) {
      const message = buildDashStaffMessage(detailWithStaff, { conflict: { conflict: true, reason: "appointment" } });
      transaction.set(db.collection(DASH_RECEIPT_COLLECTION).doc(item.notificationKey), {
        notificationKey: item.notificationKey,
        dashBookingId: detail.dashBookingId,
        status: "conflict",
        conflictReason: "schedule",
        appointmentId: existing.id,
        processedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(db.collection("staffMessages").doc(eventDocumentId), buildDashMessageDoc({
        FieldValue,
        Timestamp,
        message,
        eventType: "dash_appointment_conflict",
        entityType: "appointment",
        entityId: existing.id,
        staffId: localStaff.id,
        staffName: localStaff.name || detail.staffName,
        staffRecords,
        conflict: true
      }));
      transaction.set(db.collection("activityLog").doc(eventDocumentId), buildDashActivityLogDoc({
        FieldValue,
        detail: detailWithStaff,
        eventType: "dash_appointment_conflict",
        entityType: "appointment",
        entityId: existing.id,
        staffId: localStaff.id,
        message
      }));
      return { status: "conflict", appointmentId: existing.id, reason: "schedule" };
    }

    if (!sameSchedule && oldScheduleSnap.exists) {
      transaction.set(oldScheduleRef, {
        schemaVersion: 1,
        date: appointment.date,
        staffId: appointment.staffId,
        slots: oldSlots,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    transaction.set(newScheduleRef, {
      schemaVersion: 1,
      date: detail.date,
      staffId: localStaff.id,
      slots: newSlots,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    const previous = {
      date: appointment.date,
      time: appointment.start === undefined ? "" : minutesToTime(8 * 60 + Number(appointment.start) * 15),
      staffName: staffRecords.find(staff => staff.id === appointment.staffId)?.name || appointment.dashStaffName || ""
    };
    const message = buildDashStaffMessage(detailWithStaff, {
      eventType: "dash_appointment_rescheduled",
      previous
    });
    transaction.set(existing.ref, {
      ...updatedAppointment,
      canceled: false,
      cancelComment: null,
      lastAction: "dash_appointment_rescheduled",
      revision: Number(appointment.revision || 0) + 1,
      updatedAt: FieldValue.serverTimestamp(),
      lastActionAt: FieldValue.serverTimestamp(),
      dashObservedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(db.collection(DASH_RECEIPT_COLLECTION).doc(item.notificationKey), {
      notificationKey: item.notificationKey,
      dashBookingId: detail.dashBookingId,
      status: "rescheduled",
      appointmentId: existing.id,
      processedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(db.collection(DASH_RECEIPT_COLLECTION).doc(getDashRequestDocumentId(detail.dashBookingId)), {
      latestStatus: "rescheduled",
      latestNotificationKey: item.notificationKey,
      appointmentId: existing.id,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(db.collection("staffMessages").doc(eventDocumentId), buildDashMessageDoc({
      FieldValue,
      Timestamp,
      message,
      eventType: "dash_appointment_rescheduled",
      entityType: "appointment",
      entityId: existing.id,
      staffId: localStaff.id,
      staffName: localStaff.name || detail.staffName,
      staffRecords
    }));
    transaction.set(db.collection("activityLog").doc(eventDocumentId), buildDashActivityLogDoc({
      FieldValue,
      detail: detailWithStaff,
      eventType: "dash_appointment_rescheduled",
      entityType: "appointment",
      entityId: existing.id,
      staffId: localStaff.id,
      message
    }));
    return { status: "rescheduled", appointmentId: existing.id };
  });
}

async function importDashAppointment({
  db,
  FieldValue,
  Timestamp,
  item,
  staffRecords,
  mappings
}) {
  const detail = item.detail;
  const notificationRef = db.collection(DASH_RECEIPT_COLLECTION).doc(item.notificationKey);
  if (!detail) {
    await notificationRef.set({
      notificationKey: item.notificationKey,
      status: "parse_error",
      processedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { status: "parse_error" };
  }

  const localStaff = resolveLocalStaffForDashName(staffRecords, detail.staffName, mappings);
  const appointmentId = getDashRequestDocumentId(detail.dashBookingId);
  const receiptRef = db.collection(DASH_RECEIPT_COLLECTION).doc(appointmentId);
  const appointmentRef = db.collection("appointments").doc(appointmentId);
  const staffMessageRef = db.collection("staffMessages").doc(`dash_${appointmentId}`);
  const activityLogRef = db.collection("activityLog").doc(`dash_${appointmentId}`);

  if (!localStaff) {
    await receiptRef.set({
      dashBookingId: detail.dashBookingId,
      notificationKey: item.notificationKey,
      status: "unmapped_staff",
      dashStaffName: detail.staffName,
      processedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await notificationRef.set({
      dashBookingId: detail.dashBookingId,
      status: "unmapped_staff",
      canonicalReceiptId: appointmentId,
      processedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { status: "unmapped_staff" };
  }

  return db.runTransaction(async transaction => {
    const [existingReceipt, existingAppointment] = await Promise.all([
      transaction.get(receiptRef),
      transaction.get(appointmentRef)
    ]);
    if (
      (existingReceipt.exists && isTerminalIncomingStatus(existingReceipt.data()?.status)) ||
      existingAppointment.exists
    ) {
      transaction.set(notificationRef, {
        dashBookingId: detail.dashBookingId,
        status: "duplicate",
        canonicalReceiptId: appointmentId,
        processedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { status: "duplicate", appointmentId };
    }

    const detailWithStaff = { ...detail, staffId: localStaff.id };
    const [appointmentsSnap, offWorkSnap, weeklyOffSnap] = await Promise.all([
      transaction.get(db.collection("appointments").where("date", "==", detail.date)),
      transaction.get(db.collection("OffWork").where("date", "==", detail.date)),
      transaction.get(db.collection("WeeklyOff").where("staffId", "==", localStaff.id))
    ]);
    const appointments = appointmentsSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    const manualOffWork = offWorkSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    const weeklyOffRecords = weeklyOffSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    const weeklyExceptions = new Set(manualOffWork
      .filter(record => record.weeklyException === true && record.weeklyId)
      .map(record => record.weeklyId));
    const weeklyOccurrences = getWeeklyOffOccurrencesForDate(
      weeklyOffRecords.filter(rule => !weeklyExceptions.has(rule.id)),
      detail.date,
      localStaff.id
    );
    const conflict = findDashRequestConflict({
      detail: detailWithStaff,
      appointments,
      offWork: manualOffWork.concat(weeklyOccurrences)
    });
    const message = buildDashStaffMessage(detailWithStaff, { conflict });

    if (conflict.conflict) {
      transaction.set(receiptRef, {
        dashBookingId: detail.dashBookingId,
        notificationKey: item.notificationKey,
        status: "conflict",
        conflictReason: conflict.reason,
        staffId: localStaff.id,
        processedAt: FieldValue.serverTimestamp()
      });
      transaction.set(notificationRef, {
        dashBookingId: detail.dashBookingId,
        status: "conflict",
        canonicalReceiptId: appointmentId,
        processedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(staffMessageRef, buildDashMessageDoc({
        FieldValue,
        Timestamp,
        message,
        eventType: "dash_appointment_conflict",
        entityType: "dashBooking",
        entityId: appointmentId,
        staffId: localStaff.id,
        staffName: localStaff.name || detail.staffName,
        staffRecords,
        conflict: true
      }));
      transaction.set(activityLogRef, buildDashActivityLogDoc({
        FieldValue,
        detail: detailWithStaff,
        eventType: "dash_appointment_conflict",
        entityType: "dashBooking",
        entityId: appointmentId,
        staffId: localStaff.id,
        message
      }));
      return { status: "conflict", appointmentId, reason: conflict.reason };
    }

    const dashAppointment = buildDashAppointment(detailWithStaff, localStaff);
    const scheduleRef = db.collection(APPOINTMENT_SCHEDULE_COLLECTION)
      .doc(getScheduleId(detail.date, localStaff.id));
    const scheduleSnap = await transaction.get(scheduleRef);
    const slots = scheduleSnap.exists
      ? cloneSlots(scheduleSnap.data()?.slots)
      : buildScheduleSlots(appointments, { date: detail.date, staffId: localStaff.id, anyoneId: ANYONE_ID });
    let reservedSlots;
    try {
      reservedSlots = reserveAppointmentSlots(slots, dashAppointment, appointmentId);
    } catch (error) {
      transaction.set(receiptRef, {
        dashBookingId: detail.dashBookingId,
        notificationKey: item.notificationKey,
        status: "conflict",
        conflictReason: "schedule",
        staffId: localStaff.id,
        processedAt: FieldValue.serverTimestamp()
      });
      transaction.set(staffMessageRef, buildDashMessageDoc({
        FieldValue,
        Timestamp,
        message: buildDashStaffMessage(detailWithStaff, { conflict: { conflict: true, reason: "appointment" } }),
        eventType: "dash_appointment_conflict",
        entityType: "dashBooking",
        entityId: appointmentId,
        staffId: localStaff.id,
        staffName: localStaff.name || detail.staffName,
        staffRecords,
        conflict: true
      }));
      transaction.set(activityLogRef, buildDashActivityLogDoc({
        FieldValue,
        detail: detailWithStaff,
        eventType: "dash_appointment_conflict",
        entityType: "dashBooking",
        entityId: appointmentId,
        staffId: localStaff.id,
        message: buildDashStaffMessage(detailWithStaff, { conflict: { conflict: true, reason: "appointment" } })
      }));
      return { status: "conflict", appointmentId, reason: "schedule" };
    }

    transaction.set(scheduleRef, {
      schemaVersion: 1,
      date: detail.date,
      staffId: localStaff.id,
      slots: reservedSlots,
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.set(appointmentRef, {
      ...dashAppointment,
      createdAt: FieldValue.serverTimestamp(),
      dashObservedAt: FieldValue.serverTimestamp(),
      lastActionAt: FieldValue.serverTimestamp()
    });
    transaction.set(receiptRef, {
      dashBookingId: detail.dashBookingId,
      notificationKey: item.notificationKey,
      status: "imported",
      appointmentId,
      staffId: localStaff.id,
      processedAt: FieldValue.serverTimestamp()
    });
    transaction.set(notificationRef, {
      dashBookingId: detail.dashBookingId,
      status: "imported",
      appointmentId,
      canonicalReceiptId: appointmentId,
      processedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    transaction.set(staffMessageRef, buildDashMessageDoc({
      FieldValue,
      Timestamp,
      message,
      eventType: "dash_appointment_added",
      entityType: "appointment",
      entityId: appointmentId,
      staffId: localStaff.id,
      staffName: localStaff.name || detail.staffName,
      staffRecords,
      conflict: false
    }));
    transaction.set(activityLogRef, buildDashActivityLogDoc({
      FieldValue,
      detail: detailWithStaff,
      eventType: "dash_appointment_added",
      entityType: "appointment",
      entityId: appointmentId,
      staffId: localStaff.id,
      message
    }));
    return { status: "imported", appointmentId };
  });
}

async function processDashIncoming({ db, FieldValue, Timestamp, client, mappings }) {
  const receiptSnap = await db.collection(DASH_RECEIPT_COLLECTION)
    .orderBy("processedAt", "desc")
    .limit(300)
    .get();
  const knownNotificationKeys = new Set();
  receiptSnap.docs.forEach(docSnap => {
    const data = docSnap.data() || {};
    if (!isTerminalIncomingStatus(data.status)) return;
    knownNotificationKeys.add(docSnap.id);
    const notificationKey = String(data.notificationKey || "");
    if (notificationKey) knownNotificationKeys.add(notificationKey);
  });
  const items = await client.readDashEvents({ knownNotificationKeys, limit: 50 });
  const staffSnap = await db.collection("staff").get();
  const staffRecords = [
    { id: ANYONE_ID, name: "Anyone", active: true },
    ...staffSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }))
  ];
  const report = {
    scanned: items.length,
    imported: 0,
    canceled: 0,
    rescheduled: 0,
    conflict: 0,
    duplicate: 0,
    unmapped: 0,
    parseError: 0
  };
  for (const item of items) {
    const result = item.kind === "canceled"
      ? await cancelDashAppointment({ db, FieldValue, Timestamp, item, staffRecords })
      : item.kind === "rescheduled"
        ? await rescheduleDashAppointment({ db, FieldValue, Timestamp, item, staffRecords, mappings })
        : await importDashAppointment({
            db,
            FieldValue,
            Timestamp,
            item,
            staffRecords,
            mappings
          });
    if (result.status === "imported") report.imported += 1;
    else if (result.status === "canceled") report.canceled += 1;
    else if (result.status === "rescheduled") report.rescheduled += 1;
    else if (result.status === "conflict") report.conflict += 1;
    else if (result.status === "duplicate") report.duplicate += 1;
    else if (result.status === "unmapped_staff") report.unmapped += 1;
    else report.parseError += 1;
  }
  return report;
}

async function initializeDashIncomingBaseline({ db, FieldValue, client }) {
  const items = await client.readDashEvents({
    knownNotificationKeys: new Set(),
    limit: 50
  });
  const batch = db.batch();
  let canonical = 0;
  for (const item of items) {
    const notificationRef = db.collection(DASH_RECEIPT_COLLECTION).doc(item.notificationKey);
    const base = {
      notificationKey: item.notificationKey,
      status: item.detail ? "baseline" : "baseline_parse_error",
      processedAt: FieldValue.serverTimestamp()
    };
    if (item.detail?.dashBookingId) {
      const appointmentId = getDashRequestDocumentId(item.detail.dashBookingId);
      batch.set(notificationRef, {
        ...base,
        dashBookingId: item.detail.dashBookingId,
        canonicalReceiptId: appointmentId
      }, { merge: true });
      batch.set(db.collection(DASH_RECEIPT_COLLECTION).doc(appointmentId), {
        dashBookingId: item.detail.dashBookingId,
        notificationKey: item.notificationKey,
        status: "baseline",
        processedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      canonical += 1;
    } else {
      batch.set(notificationRef, base, { merge: true });
    }
  }
  batch.set(db.collection(DASH_CONFIG_COLLECTION).doc("runtime"), {
    inboundBaselineComplete: true,
    inboundBaselineAt: FieldValue.serverTimestamp(),
    inboundBaselineCount: canonical
  }, { merge: true });
  await batch.commit();
  return {
    baselineInitialized: true,
    scanned: items.length,
    canonical,
    imported: 0,
    conflict: 0,
    duplicate: 0,
    unmapped: 0,
    parseError: items.length - canonical
  };
}

async function runDashSyncCycle({
  db,
  FieldValue,
  Timestamp,
  email,
  password,
  executablePath = "",
  config: suppliedConfig = null
}) {
  const config = suppliedConfig
    ? buildDefaultConfig(suppliedConfig)
    : await loadDashConfig(db);
  const runRef = db.collection(DASH_RUN_COLLECTION).doc();
  if (!config.enabled) {
    await runRef.set({
      status: "disabled",
      startedAt: FieldValue.serverTimestamp(),
      finishedAt: FieldValue.serverTimestamp(),
      config
    });
    return { status: "disabled", config };
  }

  await runRef.set({ status: "running", startedAt: FieldValue.serverTimestamp(), config });
  const pendingQueueSnap = await db.collection(DASH_QUEUE_COLLECTION)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  const hasPendingQueue = !pendingQueueSnap.empty;
  if (!dashCycleNeedsBrowser(config, hasPendingQueue)) {
    const client = createDashBrowserClient(null, { dryRun: true });
    const queue = hasPendingQueue
      ? await processDashQueue({
          db,
          FieldValue,
          client,
          dryRun: true,
          limit: config.queueLimit
        })
      : { scanned: 0, created: 0, adopted: 0, updated: 0, recreated: 0, deleted: 0, noop: 0, failed: 0, dryRun: 0 };
    const report = {
      status: "completed",
      queue,
      incoming: { disabled: true },
      browserStarted: false,
      config
    };
    await runRef.set({ ...report, finishedAt: FieldValue.serverTimestamp() }, { merge: true });
    return report;
  }

  if (!String(email || "").trim() || !String(password || "")) {
    const error = new Error("Dash Booking protected sign-in values are not configured.");
    await runRef.set({
      status: "failed",
      error: sanitizeError(error),
      finishedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    throw error;
  }
  const browser = await launchDashBrowser({ executablePath });
  try {
    const page = await createAuthenticatedDashPage(browser, { email, password });
    const client = createDashBrowserClient(page, { dryRun: !config.writeEnabled });
    const mappings = await loadDashMappings(db);
    const incoming = config.inboundEnabled
      ? config.inboundBaselineComplete
        ? await processDashIncoming({ db, FieldValue, Timestamp, client, mappings })
        : await initializeDashIncomingBaseline({ db, FieldValue, client })
      : { disabled: true };
    const queue = await processDashQueue({
      db,
      FieldValue,
      client,
      dryRun: !config.writeEnabled,
      limit: config.queueLimit
    });
    const report = { status: "completed", queue, incoming, browserStarted: true, config };
    await runRef.set({ ...report, finishedAt: FieldValue.serverTimestamp() }, { merge: true });
    return report;
  } catch (error) {
    await runRef.set({
      status: "failed",
      error: sanitizeError(error),
      finishedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    throw error;
  } finally {
    await browser.close();
  }
}

module.exports = {
  APPOINTMENT_SCHEDULE_COLLECTION,
  DASH_CONFIG_COLLECTION,
  DASH_AUDIT_COLLECTION,
  DASH_ISSUE_COLLECTION,
  DASH_LINK_COLLECTION,
  DASH_MAPPING_COLLECTION,
  DASH_QUEUE_COLLECTION,
  DASH_RECEIPT_COLLECTION,
  DASH_RUN_COLLECTION,
  addDateKeyDays,
  buildDashMessageDoc,
  buildDashActivityLogDoc,
  buildDashEventDocumentId,
  buildDefaultConfig,
  dashCycleNeedsBrowser,
  dateKeyInTimeZone,
  collectDashAuditState,
  enqueueDashReconciliation,
  enqueueDashSource,
  getDashPollingWindow,
  getWeeklyOffOccurrencesForDate,
  importDashAppointment,
  cancelDashAppointment,
  rescheduleDashAppointment,
  initializeDashIncomingBaseline,
  loadDashConfig,
  loadDashMappings,
  isTerminalIncomingStatus,
  makeWeeklyOccurrence,
  processDashIncoming,
  processDashQueue,
  runDashAudit,
  runDashAuditWithBrowser,
  runDashSyncCycle,
  sanitizeError,
  weekdayForDateKey,
  weeklyRuleActiveOnDate
};
