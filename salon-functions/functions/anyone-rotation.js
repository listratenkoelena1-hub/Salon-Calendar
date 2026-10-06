"use strict";

function staffOrderValue(staff) {
  const order = Number(staff?.order);
  // Match the calendar column sort exactly: legacy records without an order
  // are treated as zero until the manager moves/saves them.
  return Number.isFinite(order) ? order : 0;
}

function sortAnyoneCandidates(candidates) {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((left, right) => (
    staffOrderValue(left) - staffOrderValue(right) ||
    String(left?.name || "").localeCompare(String(right?.name || "")) ||
    String(left?.id || "").localeCompare(String(right?.id || ""))
  ));
}

function selectAnyoneCandidate(candidates, lastAssignedStaffId = "") {
  const ordered = sortAnyoneCandidates(candidates).filter(candidate => candidate?.id);
  if (!ordered.length) return null;

  const lastIndex = ordered.findIndex(candidate => candidate.id === lastAssignedStaffId);
  const startIndex = lastIndex >= 0 ? (lastIndex + 1) % ordered.length : 0;

  for (let offset = 0; offset < ordered.length; offset += 1) {
    const candidate = ordered[(startIndex + offset) % ordered.length];
    if (candidate.available !== false) return candidate;
  }

  return null;
}

module.exports = {
  selectAnyoneCandidate,
  sortAnyoneCandidates,
  staffOrderValue
};
