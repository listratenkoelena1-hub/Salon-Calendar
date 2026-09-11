"use strict";

const crypto = require("node:crypto");

const PRIVATE_APPOINTMENT_FIELDS = new Set([
  "phone",
  "phoneLookup",
  "phoneNormalized",
  "phoneDisplay",
  "phoneLast4",
  "phoneHash",
  "contactPhone",
  "email",
  "clientId",
  "clientProfileId",
  "profileId"
]);

const HANDS_MARKER = /\b(mani(?:cure)?|hands?|fingernails?|[mfr])\b|маникюр/iu;
const FEET_MARKER = /\b(pedi(?:cure)?|toes?|toenails?|feet|p)\b|педикюр/iu;

function normalizePhone(value) {
  const raw = String(value || "").trim();
  let digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return "";
}

function getPhoneDigits(value) {
  return normalizePhone(value).replace(/\D/g, "");
}

function getPhoneLast4(value) {
  const digits = getPhoneDigits(value);
  return digits ? digits.slice(-4) : "";
}

function hashPhone(value, pepper) {
  const normalized = normalizePhone(value);
  const safePepper = String(pepper || "").trim();
  if (!normalized || !safePepper) return "";
  return crypto.createHmac("sha256", safePepper).update(normalized).digest("hex");
}

function normalizeClientName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-CA")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function damerauLevenshtein(leftValue, rightValue) {
  const left = String(leftValue || "");
  const right = String(rightValue || "");
  const matrix = Array.from(
    { length: left.length + 1 },
    () => Array(right.length + 1).fill(0)
  );

  for (let row = 0; row <= left.length; row += 1) matrix[row][0] = row;
  for (let column = 0; column <= right.length; column += 1) matrix[0][column] = column;

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + cost
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        matrix[row][column] = Math.min(
          matrix[row][column],
          matrix[row - 2][column - 2] + cost
        );
      }
    }
  }
  return matrix[left.length][right.length];
}

function getAllowedNameDistance(length) {
  if (length <= 3) return 0;
  if (length <= 7) return 1;
  return 2;
}

function getNameMatch(queryValue, candidateValue) {
  const query = normalizeClientName(queryValue);
  const candidate = normalizeClientName(candidateValue);
  if (!query || !candidate) return null;
  if (query === candidate) return { type: "exact", distance: 0, score: 1 };

  const longest = Math.max(query.length, candidate.length);
  const shortest = Math.min(query.length, candidate.length);
  const allowedDistance = getAllowedNameDistance(longest);
  if (Math.abs(query.length - candidate.length) > allowedDistance) return null;

  const distance = damerauLevenshtein(query, candidate);
  const score = longest ? 1 - distance / longest : 0;
  const minimumScore = shortest <= 4 ? 0.8 : shortest <= 7 ? 0.78 : 0.76;
  if (distance > allowedDistance || score < minimumScore) return null;
  return { type: "close", distance, score };
}

function getProfileNames(profile) {
  return [
    profile?.displayName,
    ...(Array.isArray(profile?.aliases) ? profile.aliases : [])
  ].filter(Boolean);
}

function rankNameCandidates(queryValue, profiles, limit = 5) {
  return (Array.isArray(profiles) ? profiles : [])
    .map(profile => {
      let best = null;
      getProfileNames(profile).forEach(name => {
        const match = getNameMatch(queryValue, name);
        if (!match) return;
        if (!best || match.score > best.score || (
          match.score === best.score && match.distance < best.distance
        )) best = match;
      });
      return best ? { profile, match: best } : null;
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.match.score - left.match.score ||
      left.match.distance - right.match.distance ||
      String(left.profile?.displayName || "").localeCompare(String(right.profile?.displayName || ""))
    ))
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
}

function chooseProfileMatch(name, profiles, { allowClose = true } = {}) {
  const ranked = rankNameCandidates(name, profiles, 3);
  const exact = ranked.find(candidate => candidate.match.type === "exact");
  if (exact) return { ...exact, ambiguous: false };
  if (!allowClose || !ranked.length) return null;

  const first = ranked[0];
  const second = ranked[1];
  const clearWinner = !second || first.match.score - second.match.score >= 0.08;
  if (!clearWinner) return { profile: null, match: null, ambiguous: true, candidates: ranked };
  return { ...first, ambiguous: false };
}

function normalizeServiceText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-CA")
    .replace(/[–—]/g, "-")
    .replace(/\bparaffin(?:\s+wax)?\b|парафин/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getServiceItems(input = {}) {
  if (Array.isArray(input)) return input.map(normalizeServiceText).filter(Boolean);
  if (typeof input === "string") {
    return input.split(/\s*(?:,|;|\+|\n|\||\/)\s*/u).map(normalizeServiceText).filter(Boolean);
  }
  const selected = Array.isArray(input.selectedServices)
    ? input.selectedServices.map(normalizeServiceText).filter(Boolean)
    : [];
  if (selected.length) return selected;
  return getServiceItems(input.serviceDetails || input.note || input.service || "");
}

function makeZone(key, label, explicit = true) {
  return { key, label, explicit, design: null };
}

function classifyHands(text, hasMarker = false) {
  if (/\bone\s+nail\s+extension\b/iu.test(text)) {
    return makeZone("one_nail_extension", "One nail extension");
  }
  const refill = /\b(refill|fill|correction)\b|^[fr]$|коррекц/iu.test(text);
  const newSet = /\b(new set|full set|extensions?|ext)\b|наращ/iu.test(text);
  if (/\bacrylic\b|акрил/iu.test(text)) {
    if (refill) return makeZone("acrylic_refill", "Acrylic refill");
    if (newSet) return makeZone("acrylic_new_set", "Acrylic new set");
    return makeZone("acrylic", "Acrylic");
  }
  if (/\b(hard gel|builder gel|builder|strong gel|gel overlay)\b|тверд(?:ый|ого)\s+гель|жестк(?:ий|ого)\s+гель/iu.test(text)) {
    if (refill) return makeZone("hard_gel_refill", "Hard gel refill");
    if (newSet) return makeZone("hard_gel_new_set", "Hard gel new set");
    return makeZone("hard_gel", "Hard gel");
  }
  if (refill) return makeZone("refill", "Refill");
  if (newSet) return makeZone("extensions", "Nail extensions");
  if (/\b(change (?:gel )?colou?r|colou?r change|polish change|apply gel polish)\b|смена\s+цвета/iu.test(text)) {
    return makeZone("change_color", "Gel color change");
  }
  if (/\b(no colou?r|no polish|without colou?r|cleaning only)\b|без\s+(?:цвета|лака)|чистка/iu.test(text)) {
    return makeZone("no_color", "Manicure no color");
  }
  if (/\bregular (?:polish|colou?r)\b|обычн(?:ый|ого)\s+лак/iu.test(text)) {
    return makeZone("regular_polish", "Manicure regular polish");
  }
  if (/\b(gel polish|gel colou?r|shellac)\b|гель[\s-]*лак/iu.test(text)) {
    return makeZone("gel_polish", "Manicure gel polish");
  }
  return hasMarker ? makeZone("generic_manicure", "Manicure", false) : null;
}

function classifyFeet(text, hasMarker = false) {
  const refill = /\b(refill|fill|correction)\b|коррекц/iu.test(text);
  const extension = /\b(new set|full set|extensions?|ext)\b|наращ/iu.test(text);
  if (/\b(toenail|toe)\b/iu.test(text) && refill) return makeZone("toenail_refill", "Toenail refill");
  if (/\b(toenail|toe)\b/iu.test(text) && extension) return makeZone("toenail_extension", "Toenail extension");
  if (/\b(deluxe)\b/iu.test(text)) return makeZone("deluxe", "Deluxe pedicure");
  if (/^\s*toes?\s*$/iu.test(text) || /\b(toe colou?r change|pedi colou?r change|change (?:gel )?colou?r|colou?r change|polish change)\b|смена\s+цвета/iu.test(text)) {
    return makeZone("change_color", "Toe color change");
  }
  if (/\b(no colou?r|no polish|without colou?r|cleaning only|no washing)\b|без\s+(?:цвета|лака)|чистка/iu.test(text)) {
    return makeZone("no_color", "Pedicure no color");
  }
  if (/\bregular (?:polish|colou?r)\b|обычн(?:ый|ого)\s+лак/iu.test(text)) {
    return makeZone("regular_polish", "Pedicure regular polish");
  }
  if (/\b(gel polish|gel colou?r|shellac|gel)\b|гель[\s-]*лак/iu.test(text)) {
    return makeZone("gel_polish", "Pedicure gel polish");
  }
  return hasMarker ? makeZone("generic_pedicure", "Pedicure", false) : null;
}

function getDesignValue(text) {
  if (/\b(no design|without design)\b|без\s+дизайна/iu.test(text)) return false;
  if (/\b(design|nail art|french|ombre|chrome|cat eye|glitter|floral|white tips?)\b|дизайн|френч/iu.test(text)) return true;
  return null;
}

function mergeZone(current, next) {
  if (!next) return current;
  const design = next.design === null ? current?.design ?? null : next.design;
  const material = ["hard_gel", "acrylic"].includes(current?.key)
    ? current.key
    : (["hard_gel", "acrylic"].includes(next.key) ? next.key : "");
  const treatment = ["refill", "extensions"].includes(current?.key)
    ? current.key
    : (["refill", "extensions"].includes(next.key) ? next.key : "");
  if (material && treatment) {
    const isRefill = treatment === "refill";
    return {
      key: `${material}_${isRefill ? "refill" : "new_set"}`,
      label: material === "acrylic"
        ? `Acrylic ${isRefill ? "refill" : "new set"}`
        : `Hard gel ${isRefill ? "refill" : "new set"}`,
      explicit: true,
      design
    };
  }
  if (!current || next.explicit || !current.explicit) {
    return { ...next, design };
  }
  return current;
}

function parseServiceIntent(input = {}) {
  const items = getServiceItems(input);
  const intent = { hands: null, feet: null, rawText: items.join(", ") };
  const requestedGroups = Array.isArray(input?.requestedGroups)
    ? input.requestedGroups
    : (Array.isArray(input?.serviceGroups) ? input.serviceGroups : []);
  const hasHandsGroup = requestedGroups.some(group => ["manicure", "acrylics"].includes(String(group || "").toLowerCase()));
  const hasFeetGroup = requestedGroups.some(group => String(group || "").toLowerCase() === "pedicure");
  const groupContext = hasHandsGroup !== hasFeetGroup
    ? (hasHandsGroup ? "hands" : "feet")
    : "";
  let context = "";

  items.forEach(item => {
    const text = normalizeServiceText(item);
    if (!text) return;
    const compactCombo = /\b(?:pm|mp)\b/iu.test(text);
    const feetMarker = compactCombo || FEET_MARKER.test(text);
    const handsMarker = compactCombo || HANDS_MARKER.test(text) ||
      (/\bnails?\b|ногт/iu.test(text) && !feetMarker);
    const design = getDesignValue(text);

    if (handsMarker && feetMarker) {
      intent.hands = mergeZone(intent.hands, classifyHands(text, true));
      intent.feet = mergeZone(intent.feet, classifyFeet(text, true));
      if (design !== null) {
        intent.hands.design = design;
      }
      context = "both";
      return;
    }

    if (handsMarker) context = "hands";
    else if (feetMarker) context = "feet";
    else if (/\b(acrylic|hard gel|builder gel|builder|strong gel|refill|nail extension|full set|new set)\b|акрил|наращ|коррекц|тверд(?:ый|ого)\s+гель|жестк(?:ий|ого)\s+гель/iu.test(text)) context = "hands";
    else if (/\b(deluxe|toenail)\b/iu.test(text) && intent.feet) context = "feet";
    else if (!context && groupContext) context = groupContext;

    if (handsMarker || context === "hands") {
      intent.hands = mergeZone(intent.hands, classifyHands(text, handsMarker));
      if (design !== null && intent.hands) intent.hands.design = design;
    }
    if (feetMarker || context === "feet") {
      intent.feet = mergeZone(intent.feet, classifyFeet(text, feetMarker));
      if (design !== null && intent.feet) intent.feet.design = design;
    }
    if (context === "both") {
      const hands = classifyHands(text, false);
      const feet = classifyFeet(text, false);
      if (hands) intent.hands = mergeZone(intent.hands, hands);
      if (feet) intent.feet = mergeZone(intent.feet, feet);
      if (design !== null) {
        if (intent.hands) intent.hands.design = design;
      }
    }
  });

  return intent;
}

function isGenericZone(zone) {
  return Boolean(zone && (!zone.explicit || /^generic_/.test(zone.key)));
}

function preferenceKey(zone) {
  return zone?.key || "";
}

function addZoneCount(counter, zone) {
  const key = preferenceKey(zone);
  if (!key || key === "one_nail_extension" || isGenericZone(zone)) return;
  const current = counter.get(key) || {
    key,
    label: zone.label,
    count: 0,
    designYes: 0,
    designNo: 0
  };
  current.count += 1;
  if (zone.design === true) current.designYes += 1;
  if (zone.design === false) current.designNo += 1;
  counter.set(key, current);
}

function pickRepeatedPreference(counter, minimumCount = 2) {
  const ranked = [...counter.values()].sort((left, right) => (
    right.count - left.count || left.label.localeCompare(right.label)
  ));
  const winner = ranked[0] || null;
  if (!winner || winner.count < minimumCount || ranked[1]?.count === winner.count) return null;
  const design = winner.designYes >= 2 && winner.designYes > winner.designNo
    ? true
    : (winner.designNo >= 2 && winner.designNo > winner.designYes ? false : null);
  return { key: winner.key, label: winner.label, count: winner.count, design };
}

function timestampToMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return Number(value.toMillis()) || 0;
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") return Date.parse(value) || 0;
  if (Number.isFinite(value.seconds)) return Number(value.seconds) * 1000;
  if (Number.isFinite(value._seconds)) return Number(value._seconds) * 1000;
  return 0;
}

function recordSortValue(record) {
  const date = String(record?.date || "");
  const start = Math.max(0, Number(record?.start) || 0);
  const appointmentTime = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? Date.parse(`${date}T00:00:00Z`) + start * 15 * 60 * 1000
    : 0;
  if (appointmentTime) return appointmentTime;
  return timestampToMillis(record?.updatedAt || record?.lastActionAt || record?.createdAt);
}

function recordCountsTowardPreferences(record) {
  if (!record || record.historyEligible === false) return false;
  const status = String(record.status || "").toLocaleLowerCase("en-CA");
  if (["request", "requested", "pending", "declined"].includes(status)) return false;
  if (record.lastAction === "online_request_created" || record.lastAction === "online_request_declined") return false;
  return true;
}

function getRecordIntent(record) {
  if (record?.serviceIntent && typeof record.serviceIntent === "object") return record.serviceIntent;
  return parseServiceIntent({
    selectedServices: record?.selectedServices,
    serviceDetails: record?.note ?? record?.service ?? ""
  });
}

function getServiceFingerprint(intent) {
  const parts = [];
  ["hands", "feet"].forEach(zoneName => {
    const zone = intent?.[zoneName];
    if (!zone?.key) return;
    const design = zone.design === true ? ":design" : (zone.design === false ? ":no-design" : "");
    parts.push(`${zoneName}:${zone.key}${design}`);
  });
  return parts.join("|");
}

function summarizeClientHistory(records, { minimumPreferenceCount = 2 } = {}) {
  const eligible = (Array.isArray(records) ? records : []).filter(recordCountsTowardPreferences);
  const staffCounts = new Map();
  const handsCounts = new Map();
  const feetCounts = new Map();
  const durationOverrides = new Map();
  let noShowCount = 0;

  eligible.forEach(record => {
    if (record.noShow === true) noShowCount += 1;
    if (record.staffId && record.staffId !== "anyone") {
      staffCounts.set(record.staffId, (staffCounts.get(record.staffId) || 0) + 1);
    }
    const intent = getRecordIntent(record);
    addZoneCount(handsCounts, intent.hands);
    addZoneCount(feetCounts, intent.feet);
  });

  [...eligible].sort((left, right) => recordSortValue(left) - recordSortValue(right)).forEach(record => {
    const staffId = String(record.staffId || "");
    const fingerprint = String(record.serviceFingerprint || getServiceFingerprint(getRecordIntent(record)) || "");
    const standardDuration = Number(record.standardDuration ?? record.bookingStandardDuration);
    const finalDuration = Number(record.finalDuration ?? record.duration);
    if (!staffId || staffId === "anyone" || !fingerprint) return;
    if (!Number.isInteger(standardDuration) || standardDuration < 1) return;
    if (!Number.isInteger(finalDuration) || finalDuration < 1) return;
    const key = `${staffId}|${fingerprint}`;
    if (finalDuration > standardDuration) {
      durationOverrides.set(key, {
        staffId,
        serviceFingerprint: fingerprint,
        duration: finalDuration,
        standardDuration,
        sourceAppointmentId: record.appointmentId || record.id || ""
      });
    } else {
      durationOverrides.delete(key);
    }
  });

  const rankedStaff = [...staffCounts.entries()]
    .map(([staffId, count]) => ({ staffId, count }))
    .sort((left, right) => right.count - left.count || left.staffId.localeCompare(right.staffId));
  const preferredStaff = rankedStaff[0] && rankedStaff[0].count >= 3 && rankedStaff[1]?.count !== rankedStaff[0].count
    ? rankedStaff[0]
    : null;

  return {
    appointmentCount: eligible.length,
    noShowCount,
    preferredStaff,
    hands: pickRepeatedPreference(handsCounts, minimumPreferenceCount),
    feet: pickRepeatedPreference(feetCounts, minimumPreferenceCount),
    durationOverrides: Object.fromEntries(durationOverrides)
  };
}

function preferenceToZone(preference) {
  if (!preference?.key) return null;
  return {
    key: preference.key,
    label: preference.label || preference.key,
    explicit: false,
    design: preference.design ?? null,
    inferredFromHistory: true
  };
}

function applyZonePreference(currentZone, preference, zoneName) {
  if (!currentZone || !preference?.key) return currentZone;
  const historicalZone = preferenceToZone(preference);
  if (!historicalZone) return currentZone;

  let compatible = isGenericZone(currentZone);
  if (!compatible && zoneName === "hands") {
    const currentKey = String(currentZone.key || "");
    const historicalKey = String(historicalZone.key || "");
    if (currentKey === "refill") {
      compatible = /_(?:refill)$/.test(historicalKey);
    } else if (currentKey === "extensions") {
      compatible = /_(?:new_set)$/.test(historicalKey);
    } else if (currentKey === "hard_gel") {
      compatible = /^hard_gel_(?:refill|new_set)$/.test(historicalKey);
    } else if (currentKey === "acrylic") {
      compatible = /^acrylic_(?:refill|new_set)$/.test(historicalKey);
    }
  }

  if (!compatible) return currentZone;
  return {
    ...historicalZone,
    design: currentZone.design ?? historicalZone.design
  };
}

function applyHistoryPreferences(intent, summary) {
  const effective = {
    ...intent,
    hands: intent?.hands ? { ...intent.hands } : null,
    feet: intent?.feet ? { ...intent.feet } : null
  };
  effective.hands = applyZonePreference(effective.hands, summary?.hands, "hands");
  effective.feet = applyZonePreference(effective.feet, summary?.feet, "feet");
  return effective;
}

function getPersonalizedDuration(summary, staffId, intent, standardDuration) {
  const fallback = Number(standardDuration);
  const fingerprint = getServiceFingerprint(intent);
  const key = `${String(staffId || "")}|${fingerprint}`;
  const override = summary?.durationOverrides?.[key];
  const duration = Number(override?.duration);
  const resolvedDuration = Number.isInteger(duration) && duration > fallback
    ? duration
    : fallback;
  return {
    duration: resolvedDuration,
    standardDuration: fallback,
    personalized: Number.isInteger(resolvedDuration) && resolvedDuration > fallback,
    serviceFingerprint: fingerprint,
    sourceAppointmentId: resolvedDuration > fallback ? (override?.sourceAppointmentId || "") : ""
  };
}

function stripPrivateAppointmentFields(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !PRIVATE_APPOINTMENT_FIELDS.has(key))
  );
}

module.exports = {
  applyHistoryPreferences,
  chooseProfileMatch,
  damerauLevenshtein,
  getAllowedNameDistance,
  getNameMatch,
  getPersonalizedDuration,
  getPhoneDigits,
  getPhoneLast4,
  getServiceFingerprint,
  hashPhone,
  normalizeClientName,
  normalizePhone,
  normalizeServiceText,
  parseServiceIntent,
  rankNameCandidates,
  recordCountsTowardPreferences,
  stripPrivateAppointmentFields,
  summarizeClientHistory,
  timestampToMillis
};
