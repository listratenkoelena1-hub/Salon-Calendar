"use strict";

const {
  buildBlockFingerprint,
  buildCanonicalBlockKey,
  minutesToTime,
  stableHash,
  timeToMinutes
} = require("./dash-sync-core");
const {
  getFirebaseCliAccessToken,
  run: runFirestoreAudit
} = require("./dash-firestore-audit-cli");
const {
  buildEditBlockUrl,
  createAuthenticatedDashPage,
  createDashBrowserClient,
  findDashCalendarConflicts,
  launchDashBrowser,
  readDashAppointmentById,
  readDashCalendarCards
} = require("./dash-browser");

const PROJECT_ID = "rosesnails-calendar";
const DATE = "2026-09-28";
const APPLY_CONFIRMATION = "ROSES-2026-09-28-9-ACTIONS";
const WRITE_ENV = "DASH_ONE_DAY_ENABLE_WRITES";

const STAFF = Object.freeze({
  Olha: "6632c6df8a4abe92e7c4be81",
  Olena: "677f109c3bbb234dc00035de",
  Iryna: "6632ba168a4abe92e7c0b18a",
  Natalia: "6632ccb38a4abe92e7c6504b"
});

function makeBlock({ sourceType, sourceId, start, end, staffName }) {
  const descriptionType = sourceType === "off_work"
    ? "off"
    : sourceType === "appointment_tail"
      ? "appt-tail"
      : "appt";
  const block = {
    sourceType,
    sourceId,
    date: DATE,
    start,
    end,
    dashStaffId: STAFF[staffName],
    dashStaffName: staffName,
    description: `Rose Calendar | ${descriptionType}:${sourceId}`,
    startMinutes: timeToMinutes(start),
    endMinutes: timeToMinutes(end),
    durationMinutes: timeToMinutes(end) - timeToMinutes(start)
  };
  return {
    ...block,
    canonicalKey: buildCanonicalBlockKey(block),
    fingerprint: buildBlockFingerprint(block)
  };
}

const ACTIONS = Object.freeze([
  {
    label: "Natalia appointment 10:00-12:00",
    mode: "create",
    block: makeBlock({ sourceType: "appointment", sourceId: "5M0ASyGuN3VzEuDiPjc7", start: "10:00", end: "12:00", staffName: "Natalia" })
  },
  {
    label: "Olena appointment 11:00-14:00",
    mode: "create",
    block: makeBlock({ sourceType: "appointment", sourceId: "3lpzV9v3esRoIlMobtIv", start: "11:00", end: "14:00", staffName: "Olena" })
  },
  {
    label: "Iryna appointment 10:00-11:00",
    mode: "create",
    block: makeBlock({ sourceType: "appointment", sourceId: "IO9HGME09WIjBmiijlmK", start: "10:00", end: "11:00", staffName: "Iryna" })
  },
  {
    label: "Iryna appointment 11:00-13:30",
    mode: "create",
    block: makeBlock({ sourceType: "appointment", sourceId: "GFe98SBDauWeWm6e7Fkj", start: "11:00", end: "13:30", staffName: "Iryna" })
  },
  {
    label: "Olha off-work 10:00-15:30",
    mode: "create",
    block: makeBlock({ sourceType: "off_work", sourceId: "HhTDoMo27X8bEfQCShpF", start: "10:00", end: "15:30", staffName: "Olha" })
  },
  {
    label: "Olena weekly off-work 17:00-20:00",
    mode: "create",
    block: makeBlock({ sourceType: "off_work", sourceId: "weekly_r2koXbfZvuJtapgPxzso_2026-09-28", start: "17:00", end: "20:00", staffName: "Olena" })
  },
  {
    label: "Prit extra Rose time 18:30-19:00",
    mode: "tail",
    block: makeBlock({ sourceType: "appointment_tail", sourceId: "PW6323Kqpo6lwhslKhlP", start: "18:30", end: "19:00", staffName: "Olha" })
  },
  {
    label: "Natalia replacement 13:00-14:30",
    mode: "replace",
    expectedManualBlocks: [{ dashBlockId: "6ab405b93e87e3dd8f2d1a92", start: "13:00", end: "14:15" }],
    block: makeBlock({ sourceType: "appointment", sourceId: "FsA7rs5Lk0ZOwYop4W3u", start: "13:00", end: "14:30", staffName: "Natalia" })
  },
  {
    label: "Natalia replacement 18:30-19:30",
    mode: "replace",
    expectedManualBlocks: [{ dashBlockId: "6ab405ca8ecf50d467bf66d8", start: "17:00", end: "19:00" }],
    block: makeBlock({ sourceType: "appointment", sourceId: "2pCffk8DBnVMSLRRHbvz", start: "18:30", end: "19:30", staffName: "Natalia" })
  }
]);

const EXPECTED_APPOINTMENTS = Object.freeze([
  ["5M0ASyGuN3VzEuDiPjc7", 8, 8],
  ["FsA7rs5Lk0ZOwYop4W3u", 20, 6],
  ["2pCffk8DBnVMSLRRHbvz", 42, 4],
  ["3lpzV9v3esRoIlMobtIv", 12, 12],
  ["IO9HGME09WIjBmiijlmK", 8, 4],
  ["GFe98SBDauWeWm6e7Fkj", 12, 10],
  ["PW6323Kqpo6lwhslKhlP", 30, 14],
  ["mFJuQULvcRmuax4ikhFw", 34, 10]
]);

const EXPECTED_OFF_WORK = Object.freeze([
  ["3Dci2l1GAObkYbVE59xs", false, 0, 34],
  ["G0q82dfHnoRcsN8cwrmr", false, 0, 12],
  ["HhTDoMo27X8bEfQCShpF", false, 0, 30],
  ["O7LBGXjggILjFQFKfNH9", true, null, null],
  ["mIMD66Gtet1RsiFh1opT", true, null, null]
]);

const EXPECTED_WEEKLY = Object.freeze([
  "weekly_Hv9lFGhoY9TVQhbGHFN6_2026-09-28",
  "weekly_r2koXbfZvuJtapgPxzso_2026-09-28",
  "weekly_rqEAFc7q2jy3pRjE92T3_2026-09-28"
]);

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
    if (!["project", "date", "apply", "confirm", "executable"].includes(name)) {
      throw new Error(`Unknown option --${name}.`);
    }
  }
  const options = {
    projectId: String(values.get("project") || ""),
    date: String(values.get("date") || ""),
    apply: values.get("apply") === true,
    confirmation: String(values.get("confirm") || ""),
    executablePath: String(values.get("executable") || "")
  };
  if (options.projectId !== PROJECT_ID || options.date !== DATE) {
    throw new Error(`This guarded migration accepts only ${PROJECT_ID} on ${DATE}.`);
  }
  if (options.apply && options.confirmation !== APPLY_CONFIRMATION) {
    throw new Error("The exact one-day apply confirmation is missing.");
  }
  return options;
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, found ${actual}.`);
}

function validateFirestoreReport(report) {
  assertEqual(report?.mode, "read_only", "Firestore audit mode changed");
  assertEqual(report?.project, PROJECT_ID, "Firestore project changed");
  assertEqual(report?.date, DATE, "Firestore date changed");
  assertEqual(report?.counts?.appointments, 8, "Appointment count changed");
  assertEqual(report?.counts?.offWorkDocuments, 5, "Off-work document count changed");
  assertEqual(report?.counts?.activeWeeklyOccurrences, 3, "Weekly occurrence count changed");
  assertEqual(report?.counts?.duplicateWeeklyRules, 0, "Weekly duplicates changed");

  for (const [id, start, duration] of EXPECTED_APPOINTMENTS) {
    const record = report.appointments.find(item => item.id === id);
    if (!record) throw new Error(`Expected Rose appointment ${id} is missing.`);
    assertEqual(record.start, start, `Rose appointment ${id} start changed`);
    assertEqual(record.duration, duration, `Rose appointment ${id} duration changed`);
    if (record.canceled || record.noShow) throw new Error(`Rose appointment ${id} became inactive.`);
  }
  for (const [id, allDay, start, end] of EXPECTED_OFF_WORK) {
    const record = report.offWork.find(item => item.id === id);
    if (!record) throw new Error(`Expected Rose off-work ${id} is missing.`);
    assertEqual(record.allDay, allDay, `Rose off-work ${id} all-day flag changed`);
    assertEqual(record.start, start, `Rose off-work ${id} start changed`);
    assertEqual(record.end, end, `Rose off-work ${id} end changed`);
  }
  for (const id of EXPECTED_WEEKLY) {
    if (!report.weeklyOff.some(item => item.id === id)) {
      throw new Error(`Expected Rose weekly occurrence ${id} is missing.`);
    }
  }
  return true;
}

function validateDashDay(day) {
  assertEqual(day?.date, DATE, "Dash date changed");
  assertEqual(day?.appointments?.length, 1, "Dash appointment count changed");
  const booking = day.appointments.find(item => item.dashBookingId === "6ab96c2ac52ce67927e442fd");
  if (!booking) throw new Error("The expected Dash client appointment is missing.");
  assertEqual(booking.date, DATE, "Dash client appointment date changed");
  assertEqual(booking.start, 30, "Dash client appointment start changed");
  assertEqual(booking.duration, 12, "Dash client appointment duration changed");
  assertEqual(booking.staffName, "Olha", "Dash client appointment technician changed");

  const permanentManualBlocks = [
    ["Lan", "10:00", "20:00"],
    ["Olena", "10:00", "11:00"]
  ];
  const replaceableManualBlocks = [
    ["Natalia", "13:00", "14:15"],
    ["Natalia", "17:00", "19:00"]
  ];
  for (const [staffName, start, end] of permanentManualBlocks) {
    if (!day.blocks.some(item => item.dashStaffName === staffName && item.start === start && item.end === end)) {
      throw new Error(`Expected Dash manual block ${staffName} ${start}-${end} is missing.`);
    }
  }
  const allowedKeys = new Set([
    ...permanentManualBlocks,
    ...replaceableManualBlocks
  ].map(([staffName, start, end]) => `${staffName}|${start}|${end}|`));
  for (const action of ACTIONS) {
    allowedKeys.add(`${action.block.dashStaffName}|${action.block.start}|${action.block.end}|${action.block.description}`);
  }
  for (const block of day.blocks) {
    const key = `${block.dashStaffName}|${block.start}|${block.end}|${String(block.description || "").trim()}`;
    if (!allowedKeys.has(key)) throw new Error(`Unexpected Dash block appeared on ${DATE}.`);
  }
  for (const action of ACTIONS.filter(item => item.mode === "replace")) {
    const replacementExists = day.blocks.some(item => isActionBlock(item, action));
    const oldExists = (action.expectedManualBlocks || []).some(expected => day.blocks.some(item => (
      item.dashStaffName === action.block.dashStaffName &&
      item.start === expected.start && item.end === expected.end &&
      !String(item.description || "").trim()
    )));
    if (replacementExists && oldExists) {
      throw new Error(
        `Natalia replacement state is ambiguous for ${action.label} ` +
        `(old=${oldExists ? 1 : 0}, replacement=${replacementExists ? 1 : 0}).`
      );
    }
  }
  for (const staffName of ["Olha", "Olena", "Iryna", "Natalia"]) {
    if (!day.workingStaffNames.includes(staffName)) {
      throw new Error(`Dash no longer lists ${staffName} as working on ${DATE}.`);
    }
  }
  return true;
}

function isActionBlock(block, action) {
  return block.description === action.block.description &&
    block.dashStaffName === action.block.dashStaffName &&
    block.start === action.block.start &&
    block.end === action.block.end;
}

function validatePostApply(day) {
  const booking = day.appointments.find(item => item.dashBookingId === "6ab96c2ac52ce67927e442fd");
  if (!booking || booking.start !== 30 || booking.duration !== 12 || booking.staffName !== "Olha") {
    throw new Error("The client-created Dash appointment changed during the one-day sync.");
  }
  for (const action of ACTIONS) {
    const found = day.blocks.find(item => isActionBlock(item, action));
    if (!found) throw new Error(`Post-apply verification failed for ${action.label}.`);
  }
  const staleNatalia = day.blocks.filter(item => (
    item.dashStaffName === "Natalia" &&
    ((item.start === "13:00" && item.end === "14:15") ||
      (item.start === "17:00" && item.end === "19:00"))
  ));
  if (staleNatalia.length) throw new Error("A replaced Natalia manual block is still visible.");
  return true;
}

async function readOneDaySnapshot(page, dependencies = {}) {
  const readCards = dependencies.readDashCalendarCards || readDashCalendarCards;
  const readAppointment = dependencies.readDashAppointmentById || readDashAppointmentById;
  const cards = await readCards(page, DATE);
  const workingStaffNames = await page.evaluate(() => Array.from(document.querySelectorAll("h4"))
    .map(element => ({
      name: String(element.textContent || "").replace(/\s+/g, " ").trim(),
      rect: element.getBoundingClientRect()
    }))
    .filter(item => item.name && item.rect.width > 100 && item.rect.height > 0)
    .sort((left, right) => left.rect.x - right.rect.x)
    .map(item => item.name));
  const blocks = cards.filter(item => item.isBlock).map(item => ({
    date: DATE,
    start: minutesToTime(item.startMinutes),
    end: minutesToTime(item.endMinutes),
    dashStaffName: item.dashStaffName,
    description: item.description
  }));
  const appointment = await readAppointment(page, "6ab96c2ac52ce67927e442fd");
  return {
    date: DATE,
    appointments: appointment ? [appointment] : [],
    blocks,
    cardCount: cards.length,
    workingStaffNames
  };
}

async function preflightConflicts(page, day) {
  const report = [];
  for (const action of ACTIONS) {
    if (day.blocks.some(block => isActionBlock(block, action))) {
      report.push({ label: action.label, mode: action.mode, status: "already_applied", manualBlockIds: [] });
      continue;
    }
    const oldBlockVisible = action.mode === "replace" && (action.expectedManualBlocks || []).some(expected => (
      day.blocks.some(item => (
        item.dashStaffName === action.block.dashStaffName &&
        item.start === expected.start && item.end === expected.end &&
        !String(item.description || "").trim()
      ))
    ));
    const conflicts = await findDashCalendarConflicts(page, action.block);
    const manualIds = conflicts.manualBlocks.map(item => item.dashBlockId).sort();
    const expectedManualIds = oldBlockVisible
      ? (action.expectedManualBlocks || []).map(item => item.dashBlockId).sort()
      : [];
    if (conflicts.appointments.length || conflicts.integrationBlocks.length) {
      throw new Error(`Unexpected Dash overlap found for ${action.label}.`);
    }
    if (JSON.stringify(manualIds) !== JSON.stringify(expectedManualIds)) {
      throw new Error(`Manual Dash overlap changed for ${action.label}.`);
    }
    report.push({
      label: action.label,
      mode: action.mode,
      status: action.mode === "replace" && !oldBlockVisible ? "deleted_pending_replacement" : "pending",
      manualBlockIds: manualIds
    });
  }
  return report;
}

function oldBlockLink(action, manual) {
  const link = {
    date: DATE,
    start: manual.start,
    end: manual.end,
    dashBlockId: manual.dashBlockId,
    dashStaffId: action.block.dashStaffId,
    dashStaffName: action.block.dashStaffName,
    description: ""
  };
  return { ...link, editUrl: buildEditBlockUrl(link) };
}

async function applyOneAction(client, action, { skipDelete = false } = {}) {
  if (action.mode !== "replace") return client.createBlock(action.block);
  const removed = [];
  if (!skipDelete) {
    for (const manual of action.expectedManualBlocks || []) {
      const link = oldBlockLink(action, manual);
      await client.deleteBlock(link);
      removed.push(link);
    }
  }
  try {
    const created = await client.createBlock(action.block);
    return { ...created, action: "replaced" };
  } catch (error) {
    for (const oldBlock of removed) {
      try {
        await client.createBlock({
          ...oldBlock,
          sourceType: "manual_restore",
          sourceId: oldBlock.dashBlockId,
          description: "Restored Block Time"
        });
      } catch (_restoreError) {
        // Preserve the original error. The final live verification exposes any
        // restoration failure for immediate manual repair.
      }
    }
    throw error;
  }
}

function safeActionResult(action, result) {
  return {
    label: action.label,
    mode: action.mode,
    action: String(result?.action || ""),
    dashBlockId: String(result?.dashBlockId || "")
  };
}

async function accessProtectedValue({ projectId, secretName, accessToken, fetchImpl = fetch }) {
  const url = `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${encodeURIComponent(secretName)}/versions/latest:access`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Protected Dash value ${secretName} is unavailable: HTTP ${response.status}.`);
  }
  const body = await response.json();
  const encoded = String(body?.payload?.data || "");
  if (!encoded) throw new Error(`Protected Dash value ${secretName} is empty.`);
  return Buffer.from(encoded, "base64").toString("utf8").trim();
}

async function loadProtectedDashCredentials({ projectId, environment, fetchImpl = fetch }) {
  const configuredEmail = String(environment.DASH_BOOKING_EMAIL || "").trim();
  const configuredPassword = String(environment.DASH_BOOKING_PASSWORD || "");
  if (configuredEmail && configuredPassword) {
    return { email: configuredEmail, password: configuredPassword };
  }
  const accessToken = await getFirebaseCliAccessToken(environment);
  const [email, password] = await Promise.all([
    accessProtectedValue({ projectId, secretName: "DASH_BOOKING_EMAIL", accessToken, fetchImpl }),
    accessProtectedValue({ projectId, secretName: "DASH_BOOKING_PASSWORD", accessToken, fetchImpl })
  ]);
  return { email, password };
}

async function run(options, dependencies = {}) {
  const environment = dependencies.environment || process.env;
  const { email, password } = await (dependencies.loadProtectedDashCredentials || loadProtectedDashCredentials)({
    projectId: options.projectId,
    environment,
    fetchImpl: dependencies.fetchImpl || fetch
  });
  if (!email || !password) throw new Error("Protected Dash sign-in values are unavailable.");
  if (options.apply && environment[WRITE_ENV] !== "YES") {
    throw new Error(`${WRITE_ENV}=YES is required for production writes.`);
  }

  const firestoreReport = await (dependencies.runFirestoreAudit || runFirestoreAudit)(
    { projectId: options.projectId, date: options.date },
    { environment }
  );
  validateFirestoreReport(firestoreReport);

  const browser = await (dependencies.launchDashBrowser || launchDashBrowser)({
    executablePath: options.executablePath
  });
  try {
    const page = await (dependencies.createAuthenticatedDashPage || createAuthenticatedDashPage)(
      browser,
      { email, password }
    );
    const before = await (dependencies.readOneDaySnapshot || readOneDaySnapshot)(page, dependencies);
    validateDashDay(before);
    const conflicts = await (dependencies.preflightConflicts || preflightConflicts)(page, before);
    const planHash = stableHash(JSON.stringify({
      date: DATE,
      actions: ACTIONS.map(action => ({ mode: action.mode, block: action.block })),
      conflicts
    }));
    if (!options.apply) {
      return {
        mode: "dry_run",
        project: PROJECT_ID,
        date: DATE,
        writes: 0,
        planHash,
        summary: { create: 6, replace: 2, tail: 1, total: ACTIONS.length },
        conflicts
      };
    }

    const client = (dependencies.createDashBrowserClient || createDashBrowserClient)(page, { dryRun: false });
    const completed = [];
    for (const action of ACTIONS) {
      if (before.blocks.some(block => isActionBlock(block, action))) {
        completed.push(safeActionResult(action, { action: "already_applied" }));
        continue;
      }
      const preflight = conflicts.find(item => item.label === action.label);
      const result = await applyOneAction(client, action, {
        skipDelete: preflight?.status === "deleted_pending_replacement"
      });
      completed.push(safeActionResult(action, result));
    }
    const after = await (dependencies.readOneDaySnapshot || readOneDaySnapshot)(page, dependencies);
    validatePostApply(after);
    return {
      mode: "applied",
      project: PROJECT_ID,
      date: DATE,
      writes: completed.filter(item => item.action !== "already_applied").length,
      planHash,
      summary: { create: 6, replace: 2, tail: 1, total: completed.length },
      completed,
      verification: {
        clientAppointmentUnchanged: true,
        expectedIntegrationBlocksFound: ACTIONS.length,
        staleNataliaBlocksFound: 0
      }
    };
  } finally {
    await browser.close();
  }
}

async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const report = await run(options);
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`${error.name}: guarded one-day Dash sync stopped. ${error.message}`);
    if (error?.stack) console.error(error.stack);
    process.exitCode = 1;
  });
}

module.exports = {
  ACTIONS,
  APPLY_CONFIRMATION,
  DATE,
  PROJECT_ID,
  WRITE_ENV,
  accessProtectedValue,
  loadProtectedDashCredentials,
  parseOptions,
  readOneDaySnapshot,
  run,
  validateDashDay,
  validateFirestoreReport,
  validatePostApply
};
