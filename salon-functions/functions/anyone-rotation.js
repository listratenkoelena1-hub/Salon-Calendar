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

function rotateAnyoneCandidates(candidates, lastAssignedStaffId = "") {
  const ordered = sortAnyoneCandidates(candidates).filter(candidate => candidate?.id);
  if (!ordered.length) return [];
  const lastIndex = ordered.findIndex(candidate => candidate.id === lastAssignedStaffId);
  const startIndex = lastIndex >= 0 ? (lastIndex + 1) % ordered.length : 0;
  return ordered.map((_candidate, offset) => ordered[(startIndex + offset) % ordered.length]);
}

function selectAnyoneCandidate(candidates, lastAssignedStaffId = "") {
  const ordered = rotateAnyoneCandidates(candidates, lastAssignedStaffId);
  if (!ordered.length) return null;
  for (const candidate of ordered) {
    if (candidate.available !== false) return candidate;
  }

  return null;
}

module.exports = {
  rotateAnyoneCandidates,
  selectAnyoneCandidate,
  sortAnyoneCandidates,
  staffOrderValue
};
