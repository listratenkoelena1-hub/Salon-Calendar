"use strict";

const NO_SHOW_WARNING_PATTERN = /(?:^|\n)\s*This customer didn't show up \d+ times?\.\s*(?=\n|$)/gi;
const PRIVATE_CONTACT_FIELDS = new Set([
  "phone",
  "phoneDisplay",
  "phoneLast4",
  "contactPhone",
  "email",
  "clientId",
  "profileId",
  "phoneNormalized",
  "phoneHash"
]);

function stripPrivateContactFields(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !PRIVATE_CONTACT_FIELDS.has(key))
  );
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return "";
}

function phoneLast4(value) {
  const normalized = normalizePhone(value);
  return normalized ? normalized.slice(-4) : "";
}

function normalizeClientName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function buildNameGrams(value) {
  const normalized = normalizeClientName(value).replace(/\s+/g, "_");
  if (!normalized) return [];
  if (normalized.length < 3) return [normalized];
  const padded = `^${normalized}$`;
  const grams = new Set();
  for (let index = 0; index <= padded.length - 3; index += 1) {
    grams.add(padded.slice(index, index + 3));
  }
  return [...grams].slice(0, 30);
}

function damerauLevenshtein(leftValue, rightValue) {
  const left = String(leftValue || "");
  const right = String(rightValue || "");
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(columns).fill(0));

  for (let row = 0; row < rows; row += 1) matrix[row][0] = row;
  for (let column = 0; column < columns; column += 1) matrix[0][column] = column;

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
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
  if (query === candidate) {
    return { type: "exact", distance: 0, score: 1 };
  }

  const longest = Math.max(query.length, candidate.length);
  const shortest = Math.min(query.length, candidate.length);
  if (Math.abs(query.length - candidate.length) > getAllowedNameDistance(longest)) return null;

  const distance = damerauLevenshtein(query, candidate);
  const allowedDistance = getAllowedNameDistance(longest);
  const score = longest ? 1 - distance / longest : 0;
  const minimumScore = shortest <= 4 ? 0.8 : shortest <= 7 ? 0.78 : 0.76;
  if (distance > allowedDistance || score < minimumScore) return null;
  return { type: "close", distance, score };
}

function rankNameCandidates(queryValue, profiles, limit = 5) {
  return (Array.isArray(profiles) ? profiles : [])
    .map(profile => {
      const names = [profile?.displayName, ...(Array.isArray(profile?.aliases) ? profile.aliases : [])]
        .filter(Boolean);
      let bestMatch = null;
      for (const name of names) {
        const match = getNameMatch(queryValue, name);
        if (!match) continue;
        if (!bestMatch || match.score > bestMatch.score || (
          match.score === bestMatch.score && match.distance < bestMatch.distance
        )) {
          bestMatch = match;
        }
      }
      return bestMatch ? { profile, match: bestMatch } : null;
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.match.score - left.match.score ||
      left.match.distance - right.match.distance ||
      String(left.profile?.displayName || "").localeCompare(String(right.profile?.displayName || ""))
    ))
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
}

function normalizeServiceText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

const HANDS_SERVICE_MARKER = /\b(mani(?:cure)?|nails?|hands?|acrylic|hard gel|builder gel|builder|strong gel|refill|fill|new set|full set|extensions?|ext)\b|маникюр|ногт|акрил|наращ|коррекц/u;
const FEET_SERVICE_MARKER = /\b(pedi(?:cure)?|toes?|toe color change|pedi color change|deluxe pedi)\b|педикюр/u;

function getScopedServiceText(value, kind) {
  const text = normalizeServiceText(value);
  if (!text) return "";
  const ownMarker = kind === "hands" ? HANDS_SERVICE_MARKER : FEET_SERVICE_MARKER;
  const otherMarker = kind === "hands" ? FEET_SERVICE_MARKER : HANDS_SERVICE_MARKER;
  const segments = text.split(/\s*(?:\+|;|\n|\||\/)\s*/u).filter(Boolean);
  const scoped = [];

  segments.forEach(segment => {
    const ownMatch = segment.match(ownMarker);
    if (!ownMatch) return;
    const otherMatch = segment.match(otherMarker);
    if (!otherMatch) {
      scoped.push(segment);
      return;
    }

    const ownIndex = ownMatch.index || 0;
    const otherIndex = otherMatch.index || 0;
    scoped.push(ownIndex < otherIndex
      ? segment.slice(ownIndex, otherIndex)
      : segment.slice(ownIndex));
  });

  return scoped.join(" ").trim();
}

function getHandsPreference(value) {
  const text = getScopedServiceText(value, "hands");
  if (!text) return null;
  const refill = /\b(refill|fill|correction)\b|коррекц/u.test(text);
  const newSet = /\b(new set|full set|extensions?|ext)\b|наращ/u.test(text);

  if (/\bacrylic\b|акрил/u.test(text)) {
    if (refill) return { key: "acrylic_refill", label: "Acrylic refill" };
    if (newSet) return { key: "acrylic_new_set", label: "Acrylic new set" };
    return { key: "acrylic", label: "Acrylic" };
  }
  if (/\b(hard gel|builder gel|builder|strong gel)\b/u.test(text)) {
    if (refill) return { key: "hard_gel_refill", label: "Hard gel refill" };
    if (newSet) return { key: "hard_gel_new_set", label: "Hard gel new set" };
    return { key: "hard_gel", label: "Hard gel" };
  }
  if (/\b(regular polish|regular color)\b/u.test(text)) {
    return { key: "regular_polish", label: "Regular polish" };
  }
  if (/\b(no color|no polish|cleaning only)\b/u.test(text)) {
    return { key: "no_color", label: "No color" };
  }
  if (/\b(gel polish|gel color|shellac)\b/u.test(text)) {
    return { key: "gel_polish", label: "Gel polish" };
  }
  return null;
}

function getFeetPreference(value) {
  const text = getScopedServiceText(value, "feet");
  if (!text) return null;

  if (/\b(toes?|toe color change|pedi color change|change color)\b/u.test(text)) {
    return { key: "change_color", label: "Toe color change" };
  }
  if (/\b(no color|no polish|cleaning only|no washing)\b/u.test(text)) {
    return { key: "no_color", label: "Pedicure no color" };
  }
  if (/\b(regular polish|regular color)\b/u.test(text)) {
    return { key: "regular_polish", label: "Pedicure regular polish" };
  }
  if (/\b(deluxe)\b/u.test(text)) {
    return { key: "deluxe", label: "Deluxe pedicure" };
  }
  if (/\b(gel polish|gel color|shellac)\b/u.test(text)) {
    return { key: "gel_polish", label: "Pedicure gel polish" };
  }
  return null;
}

function pickRepeatedPreference(counter, minimumCount) {
  const ranked = [...counter.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  const winner = ranked[0] || null;
  if (!winner || winner.count < minimumCount) return null;
  if (ranked[1]?.count === winner.count) return null;
  return winner;
}

function addPreferenceCount(counter, preference) {
  if (!preference?.key) return;
  const current = counter.get(preference.key) || { label: preference.label, count: 0 };
  current.count += 1;
  counter.set(preference.key, current);
}

function summarizeClientHistory(appointments) {
  const records = (Array.isArray(appointments) ? appointments : [])
    .filter(item => {
      if (!item) return false;
      const status = String(item.status || "").toLowerCase();
      return status !== "pending" && status !== "requested" && status !== "request" && item.lastAction !== "online_request_created";
    });
  const staffCounts = new Map();
  const handsCounts = new Map();
  const feetCounts = new Map();
  let noShowCount = 0;

  records.forEach(item => {
    if (item.noShow === true) noShowCount += 1;
    if (item.staffId && item.staffId !== "anyone") {
      staffCounts.set(item.staffId, (staffCounts.get(item.staffId) || 0) + 1);
    }
    const service = item.note ?? item.service ?? "";
    addPreferenceCount(handsCounts, getHandsPreference(service));
    addPreferenceCount(feetCounts, getFeetPreference(service));
  });

  const rankedStaff = [...staffCounts.entries()]
    .map(([staffId, count]) => ({ staffId, count }))
    .sort((left, right) => right.count - left.count || left.staffId.localeCompare(right.staffId));
  const preferredStaff = rankedStaff[0] && rankedStaff[0].count >= 3 && rankedStaff[1]?.count !== rankedStaff[0].count
    ? rankedStaff[0]
    : null;

  return {
    appointmentCount: records.length,
    noShowCount,
    preferredStaff,
    hands: pickRepeatedPreference(handsCounts, 2),
    feet: pickRepeatedPreference(feetCounts, 2)
  };
}

function stripNoShowWarning(value) {
  return String(value || "")
    .replace(NO_SHOW_WARNING_PATTERN, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildNoShowWarning(count) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  if (total < 2) return "";
  return `This customer didn't show up ${total} times.`;
}

function applyNoShowWarning(value, count) {
  const base = stripNoShowWarning(value);
  const warning = buildNoShowWarning(count);
  if (!warning) return base;
  return base ? `${base}\n${warning}` : warning;
}

function getAppointmentStatus(item) {
  const comment = String(item?.cancelComment || "").toLocaleLowerCase("en-US");
  const declined = item?.status === "declined" || (
    item?.canceled === true && comment.includes("online booking request declined")
  );
  if (declined) return "Declined";
  if (item?.noShow === true) return "No-show";
  if (item?.canceled === true) return "Canceled";
  return "";
}

function splitClientHistory(appointments, { today = "", currentAppointmentId = "", excludeDate = "" } = {}) {
  const todayKey = String(today || new Date().toISOString().slice(0, 10));
  const filtered = (Array.isArray(appointments) ? appointments : []).filter(item => {
    if (!item?.date) return false;
    if (currentAppointmentId && item.id === currentAppointmentId) return false;
    if (excludeDate && item.date === excludeDate) return false;
    return true;
  });
  const past = filtered
    .filter(item => String(item.date) < todayKey)
    .sort((left, right) => String(right.date).localeCompare(String(left.date)) || Number(right.start || 0) - Number(left.start || 0));
  const future = filtered
    .filter(item => String(item.date) >= todayKey)
    .sort((left, right) => String(left.date).localeCompare(String(right.date)) || Number(left.start || 0) - Number(right.start || 0));
  return { past, future };
}

module.exports = {
  applyNoShowWarning,
  buildNameGrams,
  buildNoShowWarning,
  damerauLevenshtein,
  getAllowedNameDistance,
  getAppointmentStatus,
  getFeetPreference,
  getHandsPreference,
  getNameMatch,
  normalizeClientName,
  normalizePhone,
  phoneLast4,
  rankNameCandidates,
  splitClientHistory,
  stripPrivateContactFields,
  stripNoShowWarning,
  summarizeClientHistory
};
