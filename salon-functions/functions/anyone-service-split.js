"use strict";

const { buildDurationInputFromServiceIntent } = require("./booking-duration");
const { parseServiceIntent } = require("./client-history-core");

function getHandsServiceGroups(handsIntent) {
  return String(handsIntent?.key || "").startsWith("acrylic")
    ? ["acrylics"]
    : ["manicure"];
}

function buildSegmentInput(zone, requestedGroups) {
  const intent = {
    hands: zone === "hands" ? requestedGroups.intent : null,
    feet: zone === "feet" ? requestedGroups.intent : null,
    rawText: requestedGroups.intent?.label || ""
  };
  const durationInput = buildDurationInputFromServiceIntent(intent, {
    requestedGroups: requestedGroups.groups
  });
  return {
    zone,
    intent,
    requestedGroups: requestedGroups.groups,
    selectedServices: durationInput.selectedServices || [],
    serviceDetails: durationInput.serviceDetails || requestedGroups.intent?.label || ""
  };
}

function buildHandsFeetSplitRequest(input = {}, effectiveIntent = null) {
  const inputGroups = Array.isArray(input.requestedGroups) ? input.requestedGroups : [];
  if (inputGroups.some(group => !["manicure", "acrylics", "pedicure"].includes(String(group || "").toLowerCase()))) {
    return null;
  }
  const rawText = [
    ...(Array.isArray(input.selectedServices) ? input.selectedServices : []),
    input.serviceDetails || ""
  ].join(" ");
  if (/\b(remov(?:e|ing|al)|take\s+off|cut\s+(?:toe)?nails?|nail\s+trim|toenail\s+trim|change\s+nails?\s+shape|reshape)\b/iu.test(rawText)) {
    return null;
  }
  const intent = effectiveIntent || parseServiceIntent(input);
  if (!intent?.hands?.key || !intent?.feet?.key) return null;

  return {
    hands: buildSegmentInput("hands", {
      intent: { ...intent.hands },
      groups: getHandsServiceGroups(intent.hands)
    }),
    feet: buildSegmentInput("feet", {
      intent: { ...intent.feet },
      groups: ["pedicure"]
    })
  };
}

module.exports = {
  buildHandsFeetSplitRequest,
  getHandsServiceGroups
};
