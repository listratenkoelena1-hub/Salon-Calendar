"use strict";

const {
  applyHistoryPreferences,
  getPersonalizedDuration,
  parseServiceIntent
} = require("./client-history-core");

const BOOKING_DURATION = 4;
const MAX_BOOKING_DURATION = 24;
const DEFAULT_BOOKING_SERVICE_GROUPS = ["manicure", "pedicure"];
const STAFF_BOOKING_DURATION_KEYS = new Set([
  "manicureNoColor",
  "pedicureNoColor",
  "manicureGelPolish",
  "pedicureGelPolish",
  "changeColor",
  "pedicureChangeColor",
  "refillNoDesign",
  "extensionsNoDesign",
  "eyebrowWax",
  "eyebrowWaxTinting",
  "eyelashExtensions",
  "refillLashes"
]);

function normalizeDurationSlots(value, fallback = BOOKING_DURATION) {
  const slots = Number(value);
  if (!Number.isFinite(slots) || slots <= 0) return fallback;
  return Math.max(1, Math.min(MAX_BOOKING_DURATION, Math.ceil(slots)));
}

function getStaffBookingDuration(staffRecord, key, fallback = BOOKING_DURATION) {
  const durations = staffRecord?.bookingDurations && typeof staffRecord.bookingDurations === "object"
    ? staffRecord.bookingDurations
    : {};
  if (!STAFF_BOOKING_DURATION_KEYS.has(key)) return fallback;
  return normalizeDurationSlots(durations[key], fallback);
}

function getRequestedGroups(input) {
  const groups = Array.isArray(input?.requestedGroups)
    ? input.requestedGroups.map(value => String(value || "").toLowerCase()).filter(Boolean)
    : [];
  return groups.length ? [...new Set(groups)] : DEFAULT_BOOKING_SERVICE_GROUPS;
}

function buildBookingDurationText(input = {}) {
  const selectedText = Array.isArray(input.selectedServices)
    ? input.selectedServices.join(" ")
    : "";
  return `${selectedText} ${input.serviceDetails || ""}`.toLowerCase();
}

function textMatches(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

function getRequestedBookingDurationSegments(input = {}) {
  const serviceDetails = String(input.serviceDetails || "").trim();
  if (serviceDetails) {
    const segments = serviceDetails
      .split(";")
      .map(item => item.trim())
      .filter(Boolean);
    if (segments.length) return segments;
  }

  if (Array.isArray(input.selectedServices) && input.selectedServices.length) {
    return input.selectedServices
      .map(item => String(item || "").trim())
      .filter(Boolean);
  }

  const text = buildBookingDurationText(input).trim();
  return text ? [text] : [];
}

function getShortTokens(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
  );
}

function getSegmentZones(text) {
  const zones = [];
  const shortTokens = getShortTokens(text);
  const hasCombo = shortTokens.has("pm") || shortTokens.has("mp");
  const hasFeet = hasCombo || shortTokens.has("p") || textMatches(text, [
    /\bpedicure\b/,
    /\bpedi\b/,
    /\btoe(s)?\b/,
    /\btoenail(s)?\b/,
    /педикюр/
  ]);
  const hasHands = hasCombo || ["m", "f", "r"].some(token => shortTokens.has(token)) || textMatches(text, [
    /\bmanicure\b/,
    /\bmani\b/,
    /\bfingernail(s)?\b/,
    /маникюр/,
    /ногт/
  ]);

  if (hasHands) zones.push("hands");
  if (hasFeet) zones.push("feet");
  return zones;
}

function addDurationZone(zoneSet, zone) {
  if (zone) zoneSet.add(zone);
}

function getRequestedBookingDurationSlots(input = {}, staffRecord = {}) {
  const requestedGroups = getRequestedGroups(input);
  const requestText = buildBookingDurationText(input);
  const hasNailGroups = requestedGroups.some(group => ["manicure", "pedicure", "acrylics"].includes(group));

  if (!hasNailGroups && requestedGroups.includes("brows") && /brow|eyebrow/.test(requestText)) {
    const key = /tint/.test(requestText) ? "eyebrowWaxTinting" : "eyebrowWax";
    return getStaffBookingDuration(staffRecord, key);
  }

  if (!hasNailGroups && requestedGroups.includes("lashes") && /lash|eyelash/.test(requestText)) {
    const key = /refill/.test(requestText) ? "refillLashes" : "eyelashExtensions";
    return getStaffBookingDuration(staffRecord, key);
  }

  const hasLashesOrWaxingOnly =
    requestedGroups.some(group => ["lashes", "waxing", "brows"].includes(group)) &&
    !hasNailGroups;
  if (hasLashesOrWaxingOnly) return BOOKING_DURATION;

  const segments = getRequestedBookingDurationSegments(input);
  const requestedHands = requestedGroups.some(group => ["manicure", "acrylics"].includes(group));
  const requestedFeet = requestedGroups.includes("pedicure");

  let handsMain = 0;
  let feetMain = 0;
  let removingAddOn = 0;
  let otherAddOns = 0;
  let hasOneNailExtensionOnly = false;
  const frenchZones = new Set();
  const designZones = new Set();

  segments.forEach(rawSegment => {
    const segment = String(rawSegment || "").toLowerCase();
    if (!segment) return;

    const zones = getSegmentZones(segment);
    if (!zones.length && requestedHands !== requestedFeet) {
      zones.push(requestedHands ? "hands" : "feet");
    }
    const hasHandsZone = zones.includes("hands");
    const hasFeetZone = zones.includes("feet");
    const defaultNailZone = hasFeetZone ? "feet" : "hands";
    const shortTokens = getShortTokens(segment);
    const hasCompactCombo = shortTokens.has("pm") || shortTokens.has("mp") ||
      (shortTokens.has("p") && shortTokens.has("m"));

    const hasGel = textMatches(segment, [/\bgel\b/, /\bshellac\b/, /\bgel\s*polish\b/, /гель[\s-]*лак/]);
    const hasDeluxe = textMatches(segment, [/\bdeluxe\b/]);
    const hasNoColor = textMatches(segment, [/\bno\s*colou?r\b/, /\bno\s*polish\b/, /\bwithout\s*colou?r\b/, /\bcleaning\s*only\b/, /\bno\s*washing\b/, /без\s+(?:цвета|лака)/, /чистка/]);
    const hasRegularPolish = textMatches(segment, [/\bregular\s*(?:polish|colou?r)\b/, /обычн(?:ый|ого)\s+лак/]);
    const hasChangeColor = textMatches(segment, [/\bchange\s*(?:gel\s*)?colou?r\b/, /\bpolish\s*change\b/, /\bcolou?r\s*change\b/, /\bapply\s*gel\s*polish\b/, /^\s*toes?\s*$/, /смена\s+цвета/]);
    const hasRefill = shortTokens.has("f") || shortTokens.has("r") || textMatches(segment, [/\brefill\b/, /\bfill\b/, /\bcorrection\b/, /коррекц/]);
    const hasExtensions = textMatches(segment, [/\bextension(s)?\b/, /\bext\b/, /\bnew\s*set\b/, /\bfull\s*set\b/, /наращ/]);
    const hasGelOverlay = textMatches(segment, [/\bgel\s*overlay\b/, /\boverlay\b/, /\bbuilder\s*gel\b/, /\bhard\s*gel\b/, /\bstrong\s*gel\b/, /тверд(?:ый|ого)\s+гель/, /жестк(?:ий|ого)\s+гель/]);
    const hasGelPolish = hasGel && !hasGelOverlay;
    const hasOneNailExtension = textMatches(segment, [/\bone\s*nail\s*extension\b/]);
    const hasPolishService = hasGelPolish || hasNoColor || hasRegularPolish || hasDeluxe;
    const hasManicure = hasCompactCombo || shortTokens.has("m") || textMatches(segment, [/\bmanicure\b/, /\bmani\b/, /маникюр/]) ||
      (hasHandsZone && !hasFeetZone && hasPolishService);
    const hasPedicure = hasCompactCombo || shortTokens.has("p") || textMatches(segment, [/\bpedicure\b/, /\bpedi\b/, /педикюр/]) ||
      (hasFeetZone && !hasHandsZone && hasPolishService);
    const isCombo = hasManicure && hasPedicure;
    const wantsRemoving = textMatches(segment, [/\bremov(e|ing|al)\b/, /\btake\s*off\b/]);
    const isStandaloneRemoving = wantsRemoving &&
      !isCombo &&
      !hasManicure &&
      !hasPedicure &&
      !hasRefill &&
      !(hasExtensions && !hasOneNailExtension) &&
      !hasChangeColor;

    if (!isStandaloneRemoving && isCombo) {
      if (hasGelPolish && !hasNoColor) {
        handsMain = Math.max(handsMain, getStaffBookingDuration(staffRecord, "manicureGelPolish"));
        feetMain = Math.max(feetMain, getStaffBookingDuration(staffRecord, "pedicureGelPolish"));
      } else {
        handsMain = Math.max(handsMain, getStaffBookingDuration(staffRecord, "manicureNoColor"));
        feetMain = Math.max(feetMain, getStaffBookingDuration(staffRecord, hasDeluxe && !hasNoColor ? "pedicureGelPolish" : "pedicureNoColor"));
      }
    } else if (!isStandaloneRemoving && hasFeetZone) {
      if (hasExtensions || hasRefill) feetMain = Math.max(feetMain, BOOKING_DURATION);
      if (hasChangeColor) {
        feetMain = Math.max(feetMain, getStaffBookingDuration(staffRecord, "pedicureChangeColor"));
      }
      if (hasPedicure && !hasChangeColor) {
        feetMain = Math.max(
          feetMain,
          getStaffBookingDuration(staffRecord, (hasGelPolish || hasDeluxe) && !hasNoColor ? "pedicureGelPolish" : "pedicureNoColor")
        );
      }
    } else if (!isStandaloneRemoving && (hasHandsZone || hasRefill || hasExtensions || hasGelOverlay || hasChangeColor || textMatches(segment, [/\bnail(s)?\b/]))) {
      if (hasRefill) handsMain = Math.max(handsMain, getStaffBookingDuration(staffRecord, "refillNoDesign"));
      if (hasExtensions && !hasOneNailExtension) handsMain = Math.max(handsMain, getStaffBookingDuration(staffRecord, "extensionsNoDesign"));
      if (hasGelOverlay) handsMain = Math.max(handsMain, BOOKING_DURATION);
      if (hasChangeColor) handsMain = Math.max(handsMain, getStaffBookingDuration(staffRecord, "changeColor"));
      if (hasManicure && !hasChangeColor) {
        handsMain = Math.max(
          handsMain,
          getStaffBookingDuration(staffRecord, hasGelPolish && !hasNoColor ? "manicureGelPolish" : "manicureNoColor")
        );
      }
    }

    if (isStandaloneRemoving) {
      if (textMatches(segment, [/\bacrylic\b/, /\bextension(s)?\b/, /\bnail(s)?\b/])) removingAddOn = Math.max(removingAddOn, 2);
      else if (textMatches(segment, [/\bbuilder\s*gel\b/, /\bhard\s*gel\b/])) removingAddOn = Math.max(removingAddOn, 2);
      else if (textMatches(segment, [/\bgel\b/, /\bshellac\b/, /\bcolou?r\b/])) removingAddOn = Math.max(removingAddOn, 1);
    }

    const hasFrench = textMatches(segment, [/\bfrench\b/, /\bwhite\s*tips?\b/]);
    if (hasFrench) {
      if (hasHandsZone) addDurationZone(frenchZones, "hands");
      else if (hasFeetZone) addDurationZone(frenchZones, "feet");
      else addDurationZone(frenchZones, defaultNailZone);
    }

    const explicitlyNoDesign = textMatches(segment, [
      /\bno\s*design\b/,
      /\bwithout\s*design\b/,
      /без\s+дизайна/
    ]);
    const hasDesign = !hasFrench && !explicitlyNoDesign && textMatches(segment, [/\bdesign\b/, /\bnail\s*art\b/, /\bart\b/, /\bombre\b/, /\bchrome\b/, /\bcat\s*eye\b/, /\bglitter\b/, /\bfloral\b/]);
    if (hasDesign) {
      if (hasHandsZone) addDurationZone(designZones, "hands");
      else if (hasFeetZone) addDurationZone(designZones, "feet");
      else addDurationZone(designZones, defaultNailZone);
    }

    if (hasOneNailExtension) hasOneNailExtensionOnly = true;
    if (textMatches(segment, [/\bcut\s*nails?\b/, /\bcut\s*toe\s*nails?\b/, /\bnail\s*trim\b/, /\btoenail\s*trim\b/])) otherAddOns += 1;
    if (textMatches(segment, [/\bchange\s*nails?\s*shape\b/, /\breshape\b/])) otherAddOns += 1;
  });

  let total = handsMain + feetMain + removingAddOn + otherAddOns;
  if (hasOneNailExtensionOnly && handsMain === 0) total += 1;
  total += frenchZones.size;
  total += designZones.size;
  return total > 0 ? Math.max(1, Math.min(MAX_BOOKING_DURATION, total)) : BOOKING_DURATION;
}

function buildDurationInputFromServiceIntent(intent, fallbackInput = {}) {
  const segments = [];
  if (intent?.hands?.key) {
    segments.push(`${intent.hands.label || intent.hands.key}${intent.hands.design === true ? " design" : ""}`);
  }
  if (intent?.feet?.key) {
    segments.push(`${intent.feet.label || intent.feet.key}${intent.feet.design === true ? " design" : ""}`);
  }
  if (!segments.length) return fallbackInput;
  return {
    ...fallbackInput,
    selectedServices: segments,
    serviceDetails: segments.join("; ")
  };
}

function getBookingDurationDecision(input = {}, staffRecord = {}, clientSummary = null) {
  const requestedIntent = parseServiceIntent(input);
  const effectiveIntent = applyHistoryPreferences(requestedIntent, clientSummary);
  const durationInput = buildDurationInputFromServiceIntent(effectiveIntent, input);
  const inferredFromHistory = Boolean(
    effectiveIntent?.hands?.inferredFromHistory || effectiveIntent?.feet?.inferredFromHistory
  );
  const intentDuration = getRequestedBookingDurationSlots(durationInput, staffRecord);
  const originalDuration = getRequestedBookingDurationSlots(input, staffRecord);
  let standardDuration = originalDuration;
  if (requestedIntent?.hands?.key || requestedIntent?.feet?.key) {
    const requestedIntentInput = buildDurationInputFromServiceIntent(requestedIntent, input);
    const requestedIntentDuration = getRequestedBookingDurationSlots(requestedIntentInput, staffRecord);
    const unmodeledAddOnDuration = Math.max(0, originalDuration - requestedIntentDuration);
    standardDuration = Math.max(1, Math.min(MAX_BOOKING_DURATION, intentDuration + unmodeledAddOnDuration));
  }
  const personalized = getPersonalizedDuration(
    clientSummary,
    staffRecord?.id,
    effectiveIntent,
    standardDuration
  );
  return {
    ...personalized,
    requestedIntent,
    effectiveIntent,
    inferredFromHistory
  };
}

module.exports = {
  buildDurationInputFromServiceIntent,
  getBookingDurationDecision,
  getRequestedBookingDurationSlots,
  getStaffBookingDuration
};
