"use strict";

const {
  buildCanonicalBlockKey,
  normalizeStaffName,
  rangesOverlap,
  stableHash,
  timeToMinutes
} = require("./dash-sync-core");

function normalizeClient(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-CA")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function blockSlotRange(block) {
  const startMinutes = timeToMinutes(block?.start);
  const endMinutes = timeToMinutes(block?.end);
  if (!Number.isInteger(startMinutes) || !Number.isInteger(endMinutes) || endMinutes <= startMinutes) {
    return null;
  }
  return { startMinutes, endMinutes };
}

function appointmentMinutes(appointment) {
  const start = Number(appointment?.start);
  const duration = Number(appointment?.duration);
  if (!Number.isInteger(start) || !Number.isInteger(duration) || duration < 1) return null;
  const startMinutes = 8 * 60 + start * 15;
  return { startMinutes, endMinutes: startMinutes + duration * 15 };
}

function isActiveLocalAppointment(appointment) {
  return appointment && appointment.canceled !== true && appointment.noShow !== true &&
    !(appointment.type === "online_booking_request" && (appointment.status || "request") === "request");
}

function sameDashAppointment(local, dash) {
  return String(local?.dashBookingId || local?.dashOriginBookingId || "") === String(dash?.dashBookingId || "");
}

function strictLocalMatch(local, dash) {
  return isActiveLocalAppointment(local) &&
    String(local.staffId || "") === String(dash.localStaffId || "") &&
    String(local.date || "") === String(dash.date || "") &&
    Number(local.start) === Number(dash.start) &&
    Number(local.duration) === Number(dash.duration) &&
    normalizeClient(local.client) === normalizeClient(dash.client);
}

function localOverlapsDash(local, dash) {
  if (!isActiveLocalAppointment(local)) return false;
  if (String(local.staffId || "") !== String(dash.localStaffId || "")) return false;
  if (String(local.date || "") !== String(dash.date || "")) return false;
  return rangesOverlap(
    Number(local.start),
    Number(local.start) + Number(local.duration || 1),
    Number(dash.start),
    Number(dash.start) + Number(dash.duration || 1)
  );
}

function isIntegrationBlock(block) {
  return /^Rose Calendar\s*\|\s*(?:appt|off):/i.test(String(block?.description || "").trim());
}

function sameBlockOwner(left, right) {
  if (left?.dashStaffId && right?.dashStaffId) {
    return String(left.dashStaffId) === String(right.dashStaffId);
  }
  return normalizeStaffName(left?.dashStaffName || left?.staffName) ===
    normalizeStaffName(right?.dashStaffName || right?.staffName);
}

function exactBlockCoverage(desired, observed) {
  const desiredKey = buildCanonicalBlockKey(desired);
  const observedKey = buildCanonicalBlockKey(observed);
  return Boolean(desiredKey && observedKey && desiredKey === observedKey);
}

function dedupeDesiredBlocks(desiredBlocks) {
  const byCanonicalInterval = new Map();
  const unkeyed = [];
  for (const desired of Array.isArray(desiredBlocks) ? desiredBlocks : []) {
    const canonicalKey = buildCanonicalBlockKey(desired);
    if (!canonicalKey) {
      unkeyed.push(desired);
      continue;
    }
    const existing = byCanonicalInterval.get(canonicalKey);
    if (!existing) {
      byCanonicalInterval.set(canonicalKey, {
        ...desired,
        canonicalKey,
        duplicateSources: [{ sourceType: desired.sourceType, sourceId: desired.sourceId }]
      });
      continue;
    }
    existing.duplicateSources.push({ sourceType: desired.sourceType, sourceId: desired.sourceId });
  }
  return {
    blocks: [...byCanonicalInterval.values(), ...unkeyed],
    duplicateCount: [...byCanonicalInterval.values()]
      .reduce((total, block) => total + Math.max(0, block.duplicateSources.length - 1), 0)
  };
}

function blocksOverlap(desired, observed) {
  if (String(desired?.date || "") !== String(observed?.date || "")) return false;
  if (!sameBlockOwner(desired, observed)) return false;
  const desiredRange = blockSlotRange(desired);
  const observedRange = blockSlotRange(observed);
  if (!desiredRange || !observedRange) return false;
  return rangesOverlap(
    desiredRange.startMinutes,
    desiredRange.endMinutes,
    observedRange.startMinutes,
    observedRange.endMinutes
  );
}

function desiredBlockOverlapsDashAppointment(desired, appointment) {
  if (String(desired?.date || "") !== String(appointment?.date || "")) return false;
  if (!sameBlockOwner(desired, appointment)) return false;
  const blockRange = blockSlotRange(desired);
  const appointmentRange = appointmentMinutes(appointment);
  if (!blockRange || !appointmentRange) return false;
  return rangesOverlap(
    blockRange.startMinutes,
    blockRange.endMinutes,
    appointmentRange.startMinutes,
    appointmentRange.endMinutes
  );
}

function isCoveredByDashWorkingSchedule(desired, dashWorkingStaffByDate) {
  const workingNames = dashWorkingStaffByDate?.[String(desired?.date || "")];
  if (!Array.isArray(workingNames) || !workingNames.length) return false;
  const wanted = normalizeStaffName(desired?.dashStaffName || "");
  if (!wanted) return false;
  return !workingNames.some(name => normalizeStaffName(name) === wanted);
}

function buildSummary(rows) {
  const summary = {
    roseAppointments: 0,
    roseBlocks: 0,
    dashAppointments: 0,
    dashBlocks: 0,
    alreadyMatched: 0,
    addToCalendar: 0,
    updateCalendar: 0,
    linkLocal: 0,
    createDashBlocks: 0,
    updateDashBlocks: 0,
    replaceManualBlocks: 0,
    manualBlocksFound: 0,
    needsReview: 0,
    duplicateRoseBlocks: 0
  };
  for (const row of rows) {
    if (row.kind === "dash_appointment") summary.dashAppointments += 1;
    if (row.kind === "rose_block") summary.roseBlocks += 1;
    if (["already_matched", "already_blocked", "covered_by_dash_schedule"].includes(row.action)) {
      summary.alreadyMatched += 1;
    }
    else if (row.action === "add_to_calendar") summary.addToCalendar += 1;
    else if (row.action === "update_local") summary.updateCalendar += 1;
    else if (row.action === "link_local") summary.linkLocal += 1;
    else if (row.action === "create_dash_block") summary.createDashBlocks += 1;
    else if (row.action === "update_dash_block") summary.updateDashBlocks += 1;
    else if (row.action === "replace_manual_block") summary.replaceManualBlocks += 1;
    else if (row.action === "covered_by_manual_block") summary.manualBlocksFound += 1;
    else if (row.action === "review") summary.needsReview += 1;
  }
  return summary;
}

function buildDashAuditPlan({
  startDate,
  endDate,
  localAppointments = [],
  desiredBlocks = [],
  dashAppointments = [],
  dashBlocks = [],
  dashWorkingStaffByDate = {}
} = {}) {
  const rows = [];
  const matchedLocalIds = new Set();
  const dedupedDesired = dedupeDesiredBlocks(desiredBlocks);

  for (const dash of dashAppointments) {
    const base = {
      kind: "dash_appointment",
      date: dash.date || "",
      start: dash.start,
      duration: dash.duration,
      staffId: dash.localStaffId || "",
      staffName: dash.staffName || "",
      client: dash.client || "",
      service: dash.service || "",
      dashBookingId: dash.dashBookingId || ""
    };
    if (!dash.localStaffId) {
      rows.push({ ...base, action: "review", reason: "unmapped_staff" });
      continue;
    }
    const exactId = localAppointments.find(local => sameDashAppointment(local, dash));
    if (exactId) {
      matchedLocalIds.add(exactId.id);
      const samePlacement = strictLocalMatch(exactId, dash);
      rows.push({
        ...base,
        action: samePlacement ? "already_matched" : "update_local",
        localAppointmentId: exactId.id,
        reason: samePlacement ? "dash_id_match" : "dash_id_changed"
      });
      continue;
    }
    const strictMatches = localAppointments.filter(local => strictLocalMatch(local, dash));
    if (strictMatches.length === 1) {
      matchedLocalIds.add(strictMatches[0].id);
      rows.push({
        ...base,
        action: "link_local",
        localAppointmentId: strictMatches[0].id,
        reason: "strict_legacy_match"
      });
      continue;
    }
    if (strictMatches.length > 1) {
      rows.push({ ...base, action: "review", reason: "ambiguous_local_match" });
      continue;
    }
    const conflict = localAppointments.find(local => localOverlapsDash(local, dash));
    if (conflict) {
      rows.push({
        ...base,
        action: "review",
        reason: "local_appointment_conflict",
        localAppointmentId: conflict.id
      });
      continue;
    }
    rows.push({ ...base, action: "add_to_calendar", reason: "missing_in_rose" });
  }

  for (const desired of dedupedDesired.blocks) {
    if (desired.sourceType === "appointment" && matchedLocalIds.has(desired.sourceId)) continue;
    const base = {
      kind: "rose_block",
      sourceType: desired.sourceType,
      sourceId: desired.sourceId,
      date: desired.date || "",
      start: desired.start || "",
      end: desired.end || "",
      staffName: desired.dashStaffName || "",
      dashStaffId: desired.dashStaffId || "",
      description: desired.description || "",
      fingerprint: desired.fingerprint || ""
    };
    const sameDescription = dashBlocks.find(block => (
      String(block.description || "").trim() === String(desired.description || "").trim()
    ));
    if (sameDescription) {
      rows.push({
        ...base,
        action: exactBlockCoverage(desired, sameDescription) ? "already_blocked" : "update_dash_block",
        dashBlockId: sameDescription.dashBlockId || "",
        reason: exactBlockCoverage(desired, sameDescription) ? "integration_block_match" : "integration_block_changed"
      });
      continue;
    }
    const manualExact = dashBlocks.find(block => !isIntegrationBlock(block) && exactBlockCoverage(desired, block));
    if (manualExact) {
      rows.push({
        ...base,
        action: "covered_by_manual_block",
        dashBlockId: manualExact.dashBlockId || "",
        reason: "manual_exact_coverage"
      });
      continue;
    }
    if (isCoveredByDashWorkingSchedule(desired, dashWorkingStaffByDate)) {
      rows.push({
        ...base,
        action: "covered_by_dash_schedule",
        reason: "staff_not_working_in_dash"
      });
      continue;
    }
    const appointmentConflict = dashAppointments.find(appointment => desiredBlockOverlapsDashAppointment(desired, appointment));
    if (appointmentConflict) {
      rows.push({
        ...base,
        action: "review",
        reason: "dash_appointment_overlap",
        dashBookingId: appointmentConflict?.dashBookingId || "",
      });
      continue;
    }
    const integrationConflict = dashBlocks.find(block => (
      isIntegrationBlock(block) && blocksOverlap(desired, block)
    ));
    if (integrationConflict) {
      rows.push({
        ...base,
        action: "review",
        reason: "integration_block_overlap",
        dashBlockId: integrationConflict.dashBlockId || ""
      });
      continue;
    }
    const manualConflicts = dashBlocks.filter(block => (
      !isIntegrationBlock(block) && blocksOverlap(desired, block)
    ));
    if (manualConflicts.length) {
      rows.push({
        ...base,
        action: "replace_manual_block",
        reason: "manual_partial_overlap_replace",
        dashBlockId: manualConflicts[0].dashBlockId || "",
        dashBlockIds: manualConflicts.map(block => block.dashBlockId || "").filter(Boolean)
      });
      continue;
    }
    rows.push({ ...base, action: "create_dash_block", reason: "missing_in_dash" });
  }

  const summary = buildSummary(rows);
  summary.roseAppointments = localAppointments.filter(isActiveLocalAppointment).length;
  summary.dashBlocks = dashBlocks.length;
  summary.duplicateRoseBlocks = dedupedDesired.duplicateCount;
  return {
    schemaVersion: 2,
    mode: "audit_only",
    startDate: String(startDate || ""),
    endDate: String(endDate || ""),
    checksum: stableHash(JSON.stringify(rows)),
    summary,
    rows
  };
}

module.exports = {
  blockSlotRange,
  buildDashAuditPlan,
  dedupeDesiredBlocks,
  exactBlockCoverage,
  isCoveredByDashWorkingSchedule,
  isIntegrationBlock,
  normalizeClient,
  strictLocalMatch
};
