"use strict";

const crypto = require("crypto");
const admin = require("firebase-admin");
const { defineSecret } = require("firebase-functions/params");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const {
  buildNameGrams,
  getAppointmentStatus,
  getNameMatch,
  normalizeClientName,
  normalizePhone,
  phoneLast4,
  rankNameCandidates,
  splitClientHistory,
  stripPrivateContactFields,
  summarizeClientHistory
} = require("./client-lookup-core");

if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;
const CLIENT_LOOKUP_PEPPER = defineSecret("CLIENT_LOOKUP_PEPPER");
const REGION = "us-central1";
const PRIVATE_APPOINTMENT_COLLECTION = "appointmentPrivate";
const PUBLIC_APPOINTMENT_COLLECTION = "appointmentSchedules";
const CLIENT_COLLECTION = "clientLookup";
const CLIENT_PROFILE_COLLECTION = "clientProfiles";
const CLIENT_PHONE_INDEX_COLLECTION = "clientPhoneIndex";
const CLIENT_AUDIT_COLLECTION = "clientLookupAudit";
const CLIENT_RATE_LIMIT_COLLECTION = "clientLookupRateLimits";
const PRIVATE_ACTIVITY_COLLECTION = "activityLogPrivate";
const PUBLIC_ACTIVITY_COLLECTION = "activityLogPublic";
const LOOKUP_LIMIT = 3;
const HISTORY_LINK_LIMIT = 120;
const HISTORY_PAST_LIMIT = 10;
const HISTORY_FUTURE_LIMIT = 10;

function callableOptions(extra = {}) {
  return {
    region: REGION,
    secrets: [CLIENT_LOOKUP_PEPPER],
    enforceAppCheck: false,
    ...extra
  };
}

function triggerOptions(document) {
  return {
    region: REGION,
    document,
    secrets: [CLIENT_LOOKUP_PEPPER]
  };
}

function getLookupPepper() {
  const value = String(CLIENT_LOOKUP_PEPPER.value() || "").trim();
  if (!value) throw new Error("CLIENT_LOOKUP_PEPPER is not configured.");
  return value;
}

function hashPhone(normalizedPhone) {
  return crypto
    .createHmac("sha256", getLookupPepper())
    .update(normalizedPhone)
    .digest("hex");
}

function todayInSalonTimeZone() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Edmonton",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

async function requireManager(request) {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }
  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  if (!userSnap.exists || userSnap.data()?.role !== "manager") {
    throw new HttpsError("permission-denied", "Manager access is required.");
  }
  return request.auth.uid;
}

async function consumeRateLimit(uid, key, maximum, windowMs) {
  const safeKey = String(key || "lookup").replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "lookup";
  const ref = db.collection(CLIENT_RATE_LIMIT_COLLECTION).doc(`${uid}_${safeKey}`);
  const now = Date.now();
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() || {};
    const windowStartedAt = Number(data.windowStartedAt) || 0;
    const insideWindow = now - windowStartedAt < windowMs;
    const count = insideWindow ? Number(data.count) || 0 : 0;
    if (count >= maximum) {
      throw new HttpsError("resource-exhausted", "Please wait a moment before searching again.");
    }
    transaction.set(ref, {
      windowStartedAt: insideWindow ? windowStartedAt : now,
      count: count + 1,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  });
}

function isDeclinedOnlineAppointment(data) {
  const comment = String(data?.cancelComment || "").toLowerCase();
  const isOnline = data?.source === "online_booking" || data?.type === "online_booking_request";
  return isOnline && (
    data?.status === "declined" ||
    (data?.canceled === true && comment.includes("online booking request declined"))
  );
}

function isPendingOnlineAppointment(data) {
  const isOnline = data?.source === "online_booking" || data?.type === "online_booking_request";
  return isOnline && (
    data?.status === "pending" ||
    data?.status === "requested" ||
    data?.status === "request" ||
    data?.lastAction === "online_request_created"
  );
}

function canCreateIdentityFromAppointment(data) {
  if (!data?.phone) return false;
  if (isPendingOnlineAppointment(data) || isDeclinedOnlineAppointment(data)) return false;
  return true;
}

function sanitizeAppointmentForCalendar(data) {
  return stripPrivateContactFields(data);
}

function sanitizeActivityLog(data) {
  return stripPrivateContactFields(data);
}

async function getPhoneIdentity(normalizedPhone) {
  if (!normalizedPhone) return null;
  const phoneHash = hashPhone(normalizedPhone);
  const indexSnap = await db.collection(CLIENT_PHONE_INDEX_COLLECTION).doc(phoneHash).get();
  if (!indexSnap.exists || !indexSnap.data()?.clientId) return null;
  const clientId = String(indexSnap.data().clientId);
  const clientSnap = await db.collection(CLIENT_COLLECTION).doc(clientId).get();
  if (!clientSnap.exists) return null;
  return { clientId, client: clientSnap.data(), phoneHash };
}

async function ensurePhoneIdentity(normalizedPhone, phoneDisplay, allowCreate) {
  const phoneHash = hashPhone(normalizedPhone);
  const indexRef = db.collection(CLIENT_PHONE_INDEX_COLLECTION).doc(phoneHash);
  const result = await db.runTransaction(async transaction => {
    const indexSnap = await transaction.get(indexRef);
    if (indexSnap.exists && indexSnap.data()?.clientId) {
      return { clientId: String(indexSnap.data().clientId), created: false };
    }
    if (!allowCreate) return null;

    const clientRef = db.collection(CLIENT_COLLECTION).doc();
    transaction.create(clientRef, {
      phoneNormalized: normalizedPhone,
      phoneDisplay: String(phoneDisplay || normalizedPhone),
      phoneLast4: phoneLast4(normalizedPhone),
      phoneHash,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    transaction.create(indexRef, {
      clientId: clientRef.id,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { clientId: clientRef.id, created: true };
  });

  if (!result) return null;
  const clientRef = db.collection(CLIENT_COLLECTION).doc(result.clientId);
  if (!result.created) {
    await clientRef.set({
      phoneDisplay: String(phoneDisplay || normalizedPhone),
      phoneLast4: phoneLast4(normalizedPhone),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }
  const clientSnap = await clientRef.get();
  return { clientId: result.clientId, client: clientSnap.data() || {}, phoneHash, created: result.created };
}

async function getProfilesForClient(clientId) {
  const snapshot = await db.collection(CLIENT_PROFILE_COLLECTION)
    .where("clientId", "==", clientId)
    .limit(30)
    .get();
  return snapshot.docs.map(document => ({ id: document.id, ...document.data() }));
}

async function getProfile(profileId) {
  if (!profileId) return null;
  const snapshot = await db.collection(CLIENT_PROFILE_COLLECTION).doc(String(profileId)).get();
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

async function findProfilesByName(name) {
  const normalized = normalizeClientName(name);
  if (normalized.length < 2) return [];
  const profiles = new Map();
  const exactSnap = await db.collection(CLIENT_PROFILE_COLLECTION)
    .where("nameNormalized", "==", normalized)
    .limit(20)
    .get();
  exactSnap.docs.forEach(document => profiles.set(document.id, { id: document.id, ...document.data() }));

  if (profiles.size < 20 && normalized.length >= 4) {
    const grams = buildNameGrams(normalized).slice(0, 10);
    if (grams.length) {
      const closeSnap = await db.collection(CLIENT_PROFILE_COLLECTION)
        .where("nameGrams", "array-contains-any", grams)
        .limit(40)
        .get();
      closeSnap.docs.forEach(document => profiles.set(document.id, { id: document.id, ...document.data() }));
    }
  }
  return rankNameCandidates(normalized, [...profiles.values()], 8);
}

async function createProfile(clientId, displayName) {
  const name = String(displayName || "").trim();
  const normalized = normalizeClientName(name);
  if (!normalized) return null;
  const profileKey = crypto
    .createHash("sha256")
    .update(`${clientId}\n${normalized}`)
    .digest("hex");
  const ref = db.collection(CLIENT_PROFILE_COLLECTION).doc(profileKey);
  const data = {
    clientId,
    displayName: name,
    nameNormalized: normalized,
    nameGrams: buildNameGrams(normalized),
    aliases: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
  try {
    await ref.create(data);
    return { id: ref.id, ...data };
  } catch (error) {
    if (String(error?.code || "").toLowerCase() !== "6" && !String(error?.code || "").includes("already-exists")) {
      throw error;
    }
    const existing = await ref.get();
    return existing.exists ? { id: existing.id, ...existing.data() } : null;
  }
}

async function addProfileAlias(profile, alias) {
  const displayAlias = String(alias || "").trim();
  const normalizedAlias = normalizeClientName(displayAlias);
  if (!profile?.id || !normalizedAlias || normalizedAlias === profile.nameNormalized) return;
  const aliases = Array.isArray(profile.aliases) ? profile.aliases : [];
  if (aliases.some(value => normalizeClientName(value) === normalizedAlias)) return;
  const aliasMatch = getNameMatch(profile.displayName, displayAlias);
  if (!aliasMatch) return;
  await db.collection(CLIENT_PROFILE_COLLECTION).doc(profile.id).set({
    aliases: FieldValue.arrayUnion(displayAlias),
    nameGrams: FieldValue.arrayUnion(...buildNameGrams(displayAlias)),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

async function resolveProfileForAppointment({ clientId, clientName, selectedProfileId, allowCreateProfile }) {
  const profiles = await getProfilesForClient(clientId);
  if (selectedProfileId) {
    const selected = profiles.find(profile => profile.id === String(selectedProfileId));
    if (!selected) {
      throw new HttpsError("failed-precondition", "The selected client does not match this phone number.");
    }
    await addProfileAlias(selected, clientName);
    return selected;
  }

  const normalizedName = normalizeClientName(clientName);
  if (!normalizedName) return null;
  const exact = profiles.find(profile => profile.nameNormalized === normalizedName || (
    Array.isArray(profile.aliases) && profile.aliases.some(alias => normalizeClientName(alias) === normalizedName)
  ));
  if (exact) return exact;
  const closeMatches = rankNameCandidates(normalizedName, profiles, 2);
  if (
    closeMatches.length === 1 ||
    (closeMatches[0] && closeMatches[1] && closeMatches[0].match.score > closeMatches[1].match.score)
  ) {
    const closeProfile = closeMatches[0]?.profile;
    if (closeProfile) {
      await addProfileAlias(closeProfile, clientName);
      return closeProfile;
    }
  }
  if (!allowCreateProfile) return null;
  return createProfile(clientId, clientName);
}

async function linkAppointmentIdentity(appointmentId, data, {
  selectedProfileId = "",
  allowCreate,
  noShowWarningDismissedCount = null
} = {}) {
  const normalizedPhone = normalizePhone(data?.phone);
  if (!appointmentId || !normalizedPhone) {
    if (appointmentId) await db.collection(PRIVATE_APPOINTMENT_COLLECTION).doc(appointmentId).delete().catch(() => {});
    return { linked: false, reason: "phone-missing" };
  }

  const identity = await ensurePhoneIdentity(normalizedPhone, data.phone, allowCreate);
  if (!identity) return { linked: false, reason: "identity-not-created" };
  const profile = await resolveProfileForAppointment({
    clientId: identity.clientId,
    clientName: data.client,
    selectedProfileId,
    allowCreateProfile: allowCreate
  });

  const privateAppointment = {
    appointmentId,
    clientId: identity.clientId,
    profileId: profile?.id || null,
    phoneNormalized: normalizedPhone,
    phoneDisplay: String(data.phone || normalizedPhone),
    phoneLast4: phoneLast4(normalizedPhone),
    phoneHash: identity.phoneHash,
    source: String(data.source || "calendar"),
    updatedAt: FieldValue.serverTimestamp(),
    ...(identity.created ? { createdAt: FieldValue.serverTimestamp() } : {})
  };
  if (Number.isFinite(Number(noShowWarningDismissedCount))) {
    privateAppointment.noShowWarningDismissedCount = Math.max(
      0,
      Math.floor(Number(noShowWarningDismissedCount) || 0)
    );
  }
  await db.collection(PRIVATE_APPOINTMENT_COLLECTION).doc(appointmentId).set(privateAppointment, { merge: true });

  if (profile?.id) {
    await db.collection(CLIENT_PROFILE_COLLECTION).doc(profile.id).set({
      lastLinkedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  return {
    linked: true,
    createdClient: identity.created === true,
    profileId: profile?.id || null
  };
}

async function readLinkedAppointments(profileId) {
  if (!profileId) return [];
  const linksSnap = await db.collection(PRIVATE_APPOINTMENT_COLLECTION)
    .where("profileId", "==", profileId)
    .limit(HISTORY_LINK_LIMIT)
    .get();
  const ids = linksSnap.docs.map(document => document.id);
  const records = [];
  for (let index = 0; index < ids.length; index += 50) {
    const refs = ids.slice(index, index + 50).map(id => db.collection("appointments").doc(id));
    if (!refs.length) continue;
    const snapshots = await db.getAll(...refs);
    snapshots.forEach(snapshot => {
      if (snapshot.exists) records.push({ id: snapshot.id, ...snapshot.data() });
    });
  }
  return records;
}

async function getStaffNameMap(appointments) {
  const ids = [...new Set((appointments || []).map(item => item.staffId).filter(id => id && id !== "anyone"))];
  const map = new Map([["anyone", "Anyone"]]);
  for (let index = 0; index < ids.length; index += 50) {
    const refs = ids.slice(index, index + 50).map(id => db.collection("staff").doc(id));
    if (!refs.length) continue;
    const snapshots = await db.getAll(...refs);
    snapshots.forEach(snapshot => {
      if (snapshot.exists) map.set(snapshot.id, snapshot.data()?.name || "Unknown");
    });
  }
  return map;
}

function toPublicHistoryAppointment(item, staffNames) {
  return {
    id: item.id,
    date: String(item.date || ""),
    start: Number(item.start) || 0,
    duration: Number(item.duration) || 0,
    staffId: String(item.staffId || ""),
    staffName: staffNames.get(item.staffId) || "Unknown",
    client: String(item.client || ""),
    note: String(item.note ?? item.service ?? ""),
    status: getAppointmentStatus(item),
    source: item.source === "online_booking" ? "online_booking" : "calendar",
    noShow: item.noShow === true,
    canceled: item.canceled === true,
    cancelComment: String(item.cancelComment || "")
  };
}

async function buildCandidate(profile, client, match, input) {
  const history = await readLinkedAppointments(profile.id);
  const filtered = history.filter(item => (
    (!input.currentAppointmentId || item.id !== input.currentAppointmentId) &&
    (!input.appointmentDate || item.date !== input.appointmentDate)
  ));
  const staffNames = await getStaffNameMap(filtered);
  const sections = splitClientHistory(filtered, { today: todayInSalonTimeZone() });
  const summary = summarizeClientHistory(filtered);
  const preferredStaff = summary.preferredStaff
    ? {
        ...summary.preferredStaff,
        name: staffNames.get(summary.preferredStaff.staffId) || "Unknown"
      }
    : null;
  const lastAppointment = sections.past[0] || sections.future[0] || null;
  let noShowWarningDismissedCount = 0;
  if (input.currentAppointmentId) {
    const currentPrivateSnap = await db.collection(PRIVATE_APPOINTMENT_COLLECTION)
      .doc(String(input.currentAppointmentId))
      .get();
    if (currentPrivateSnap.exists && currentPrivateSnap.data()?.profileId === profile.id) {
      noShowWarningDismissedCount = Math.max(
        0,
        Number(currentPrivateSnap.data()?.noShowWarningDismissedCount) || 0
      );
    }
  }

  return {
    profileId: profile.id,
    name: String(profile.displayName || ""),
    phone: String(client.phoneDisplay || client.phoneNormalized || ""),
    match: match?.type || "phone",
    confidence: Number(match?.score ?? 1),
    historyCount: filtered.length,
    pastCount: sections.past.length,
    futureCount: sections.future.length,
    canOpenHistory: filtered.length >= 2,
    lastAppointment: lastAppointment ? toPublicHistoryAppointment(lastAppointment, staffNames) : null,
    noShowCount: summary.noShowCount,
    noShowWarningDismissedCount,
    preferredStaff,
    preferences: {
      hands: summary.hands,
      feet: summary.feet
    }
  };
}

async function auditLookup(uid, kind, resultCount) {
  await db.collection(CLIENT_AUDIT_COLLECTION).add({
    uid,
    kind,
    resultCount: Number(resultCount) || 0,
    createdAt: FieldValue.serverTimestamp()
  }).catch(error => console.warn("Client lookup audit was not written:", error));
}

exports.managerLookupClient = onCall(callableOptions({ maxInstances: 12 }), async request => {
  const uid = await requireManager(request);
  await consumeRateLimit(uid, "lookup", 60, 60 * 1000);
  const input = request.data || {};
  const normalizedPhone = normalizePhone(input.phone);
  const normalizedName = normalizeClientName(input.name);
  let candidates = [];
  let kind = "none";

  if (normalizedPhone) {
    kind = "phone";
    const identity = await getPhoneIdentity(normalizedPhone);
    if (identity) {
      const profiles = await getProfilesForClient(identity.clientId);
      const ranked = normalizedName ? rankNameCandidates(normalizedName, profiles, 8) : [];
      const matchByProfileId = new Map(ranked.map(item => [item.profile.id, item.match]));
      const orderedProfiles = ranked.length
        ? [...ranked.map(item => item.profile), ...profiles.filter(profile => !matchByProfileId.has(profile.id))]
        : profiles;
      for (const profile of orderedProfiles.slice(0, LOOKUP_LIMIT)) {
        candidates.push(await buildCandidate(
          profile,
          identity.client,
          matchByProfileId.get(profile.id) || { type: "phone", score: 1 },
          input
        ));
      }
    }
  } else if (normalizedName.length >= 2) {
    kind = "name";
    const rankedProfiles = await findProfilesByName(normalizedName);
    for (const ranked of rankedProfiles.slice(0, LOOKUP_LIMIT)) {
      const clientSnap = await db.collection(CLIENT_COLLECTION).doc(ranked.profile.clientId).get();
      if (!clientSnap.exists) continue;
      candidates.push(await buildCandidate(ranked.profile, clientSnap.data(), ranked.match, input));
    }
  }

  candidates = candidates.slice(0, LOOKUP_LIMIT);
  await auditLookup(uid, kind, candidates.length);
  return { ok: true, kind, candidates };
});

exports.managerGetClientHistory = onCall(callableOptions({ maxInstances: 8 }), async request => {
  const uid = await requireManager(request);
  await consumeRateLimit(uid, "history", 30, 60 * 1000);
  const input = request.data || {};
  const profile = await getProfile(input.profileId);
  if (!profile) throw new HttpsError("not-found", "Client history was not found.");
  const clientSnap = await db.collection(CLIENT_COLLECTION).doc(profile.clientId).get();
  if (!clientSnap.exists) throw new HttpsError("not-found", "Client contact was not found.");

  const history = await readLinkedAppointments(profile.id);
  const filtered = history.filter(item => (
    (!input.currentAppointmentId || item.id !== input.currentAppointmentId) &&
    (!input.appointmentDate || item.date !== input.appointmentDate)
  ));
  const staffNames = await getStaffNameMap(filtered);
  const sections = splitClientHistory(filtered, { today: todayInSalonTimeZone() });
  const summary = summarizeClientHistory(filtered);
  return {
    ok: true,
    client: {
      name: String(profile.displayName || ""),
      phone: String(clientSnap.data()?.phoneDisplay || clientSnap.data()?.phoneNormalized || "")
    },
    summary: {
      ...summary,
      preferredStaff: summary.preferredStaff ? {
        ...summary.preferredStaff,
        name: staffNames.get(summary.preferredStaff.staffId) || "Unknown"
      } : null
    },
    past: sections.past.slice(0, HISTORY_PAST_LIMIT).map(item => toPublicHistoryAppointment(item, staffNames)),
    future: sections.future.slice(0, HISTORY_FUTURE_LIMIT).map(item => toPublicHistoryAppointment(item, staffNames)),
    totalCount: filtered.length
  };
});

exports.managerLinkAppointmentClient = onCall(callableOptions({ maxInstances: 10 }), async request => {
  const uid = await requireManager(request);
  await consumeRateLimit(uid, "link", 40, 60 * 1000);
  const input = request.data || {};
  const appointmentId = String(input.appointmentId || "").trim();
  if (!appointmentId) throw new HttpsError("invalid-argument", "Appointment ID is required.");
  const appointmentSnap = await db.collection("appointments").doc(appointmentId).get();
  if (!appointmentSnap.exists) throw new HttpsError("not-found", "Appointment was not found.");
  const data = appointmentSnap.data() || {};
  const result = await linkAppointmentIdentity(appointmentId, data, {
    selectedProfileId: String(input.profileId || ""),
    allowCreate: canCreateIdentityFromAppointment(data),
    noShowWarningDismissedCount: input.noShowWarningDismissedCount
  });
  return { ok: true, ...result };
});

exports.managerStoreActivityContact = onCall(callableOptions({ maxInstances: 8 }), async request => {
  const uid = await requireManager(request);
  await consumeRateLimit(uid, "logcontact", 80, 60 * 1000);
  const input = request.data || {};
  const logId = String(input.logId || "").trim();
  const normalizedPhone = normalizePhone(input.phone);
  if (!logId || !normalizedPhone) return { ok: true, stored: false };
  const logSnap = await db.collection("activityLog").doc(logId).get();
  if (!logSnap.exists) throw new HttpsError("not-found", "Activity log entry was not found.");
  await db.collection(PRIVATE_ACTIVITY_COLLECTION).doc(logId).set({
    phoneNormalized: normalizedPhone,
    phoneDisplay: String(input.phone || normalizedPhone),
    phoneLast4: phoneLast4(normalizedPhone),
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return { ok: true, stored: true };
});

exports.managerGetActivityContacts = onCall(callableOptions({ maxInstances: 8 }), async request => {
  const uid = await requireManager(request);
  await consumeRateLimit(uid, "logread", 24, 60 * 1000);
  const logDate = String(request.data?.logDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(logDate)) {
    throw new HttpsError("invalid-argument", "A valid activity-log date is required.");
  }
  let logIds = [...new Set((Array.isArray(request.data?.logIds) ? request.data.logIds : [])
    .map(value => String(value || "").trim())
    .filter(Boolean))].slice(0, 50);
  if (!logIds.length) return { ok: true, contacts: {} };
  const publicLogs = await db.getAll(...logIds.map(id => db.collection(PUBLIC_ACTIVITY_COLLECTION).doc(id)));
  const allowedIds = new Set(publicLogs
    .filter(snapshot => snapshot.exists && snapshot.data()?.logDate === logDate)
    .map(snapshot => snapshot.id));
  logIds = logIds.filter(id => allowedIds.has(id));
  if (!logIds.length) return { ok: true, contacts: {} };
  const snapshots = await db.getAll(...logIds.map(id => db.collection(PRIVATE_ACTIVITY_COLLECTION).doc(id)));
  const contacts = {};
  snapshots.forEach(snapshot => {
    if (snapshot.exists) contacts[snapshot.id] = String(snapshot.data()?.phoneDisplay || "");
  });
  return { ok: true, contacts };
});

exports.managerGetAppointmentContact = onCall(callableOptions({ maxInstances: 10 }), async request => {
  const uid = await requireManager(request);
  await consumeRateLimit(uid, "appointmentcontact", 30, 60 * 1000);
  const batchRequested = Array.isArray(request.data?.appointmentIds);
  const requestedIds = [
    request.data?.appointmentId,
    ...(Array.isArray(request.data?.appointmentIds) ? request.data.appointmentIds : [])
  ];
  let appointmentIds = [...new Set(requestedIds
    .map(value => String(value || "").trim())
    .filter(Boolean))].slice(0, 30);
  if (!appointmentIds.length) throw new HttpsError("invalid-argument", "Appointment ID is required.");

  if (batchRequested) {
    const nameQuery = normalizeClientName(request.data?.nameQuery);
    if (nameQuery.length < 3) {
      throw new HttpsError("invalid-argument", "Enter at least three client-name characters.");
    }
    const publicAppointments = await db.getAll(...appointmentIds.map(id => (
      db.collection(PUBLIC_APPOINTMENT_COLLECTION).doc(id)
    )));
    const allowedIds = new Set(publicAppointments
      .filter(snapshot => (
        snapshot.exists && normalizeClientName(snapshot.data()?.client).includes(nameQuery)
      ))
      .map(snapshot => snapshot.id));
    appointmentIds = appointmentIds.filter(id => allowedIds.has(id));
    if (!appointmentIds.length) return { ok: true, contacts: {} };
  }

  const privateSnapshots = await db.getAll(...appointmentIds.map(id => (
    db.collection(PRIVATE_APPOINTMENT_COLLECTION).doc(id)
  )));
  const contacts = {};
  const missingIds = [];
  privateSnapshots.forEach(snapshot => {
    if (snapshot.exists) {
      contacts[snapshot.id] = String(snapshot.data()?.phoneDisplay || "");
    } else {
      missingIds.push(snapshot.id);
    }
  });

  // Temporary compatibility path while the exact-phone backfill is being
  // completed. It returns only explicitly requested contacts, never a list.
  if (missingIds.length) {
    const legacySnapshots = await db.getAll(...missingIds.map(id => db.collection("appointments").doc(id)));
    legacySnapshots.forEach(snapshot => {
      if (snapshot.exists) contacts[snapshot.id] = String(snapshot.data()?.phone || "");
    });
  }

  const singleId = String(request.data?.appointmentId || "").trim();
  await auditLookup(uid, batchRequested ? "appointment-contact-batch" : "appointment-contact", Object.keys(contacts).length);
  return {
    ok: true,
    contacts,
    ...(singleId ? { phone: contacts[singleId] || "" } : {})
  };
});

exports.managerSearchAppointmentContacts = onCall(callableOptions({ maxInstances: 8 }), async request => {
  const uid = await requireManager(request);
  await consumeRateLimit(uid, "phonesearch", 30, 60 * 1000);
  const queryDigits = String(request.data?.query || "").replace(/\D/g, "");
  if (queryDigits.length < 4) {
    throw new HttpsError("invalid-argument", "Enter at least four phone digits.");
  }

  const normalizedPhone = normalizePhone(request.data?.query);
  let lookup = db.collection(PRIVATE_APPOINTMENT_COLLECTION);
  if (normalizedPhone && queryDigits.length >= 8) {
    lookup = lookup.where("phoneHash", "==", hashPhone(normalizedPhone));
  } else {
    lookup = lookup.where("phoneLast4", "==", queryDigits.slice(-4));
  }

  const snapshot = await lookup.limit(80).get();
  const matches = snapshot.docs
    .map(document => ({
      appointmentId: document.id,
      phone: String(document.data()?.phoneDisplay || document.data()?.phoneNormalized || ""),
      phoneDigits: String(document.data()?.phoneNormalized || "").replace(/\D/g, "")
    }))
    .filter(item => normalizedPhone || item.phoneDigits.includes(queryDigits))
    .slice(0, 60)
    .map(({ appointmentId, phone }) => ({ appointmentId, phone }));

  await auditLookup(uid, "phone-archive", matches.length);
  return { ok: true, matches };
});

exports.managerBackfillActivityLogPrivacy = onCall(callableOptions({ timeoutSeconds: 120, maxInstances: 1 }), async request => {
  const uid = await requireManager(request);
  await consumeRateLimit(uid, "logbackfill", 6, 60 * 1000);
  const input = request.data || {};
  const pageSize = Math.max(1, Math.min(50, Number(input.pageSize) || 25));
  const dryRun = input.dryRun !== false;
  let query = db.collection("activityLog").orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
  if (input.cursor) query = query.startAfter(String(input.cursor));
  const snapshot = await query.get();
  let contactCount = 0;

  for (const document of snapshot.docs) {
    const data = document.data() || {};
    const normalizedPhone = normalizePhone(data.phone);
    if (normalizedPhone) contactCount += 1;
    if (dryRun) continue;
    await db.collection(PUBLIC_ACTIVITY_COLLECTION).doc(document.id).set(
      sanitizeActivityLog(data),
      { merge: false }
    );
    if (normalizedPhone) {
      await db.collection(PRIVATE_ACTIVITY_COLLECTION).doc(document.id).set({
        phoneNormalized: normalizedPhone,
        phoneDisplay: String(data.phone || normalizedPhone),
        phoneLast4: phoneLast4(normalizedPhone),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  }

  await db.collection(CLIENT_AUDIT_COLLECTION).add({
    uid,
    kind: "activity-log-backfill",
    dryRun,
    scanned: snapshot.size,
    contactCount,
    createdAt: FieldValue.serverTimestamp()
  });
  return {
    ok: true,
    dryRun,
    scanned: snapshot.size,
    contactCount,
    nextCursor: snapshot.docs.length === pageSize ? snapshot.docs[snapshot.docs.length - 1].id : null
  };
});

exports.managerBackfillClientLookup = onCall(callableOptions({ timeoutSeconds: 120, maxInstances: 1 }), async request => {
  const uid = await requireManager(request);
  await consumeRateLimit(uid, "backfill", 6, 60 * 1000);
  const input = request.data || {};
  const pageSize = Math.max(1, Math.min(50, Number(input.pageSize) || 25));
  const dryRun = input.dryRun !== false;
  let query = db.collection("appointments").orderBy(admin.firestore.FieldPath.documentId()).limit(pageSize);
  if (input.cursor) query = query.startAfter(String(input.cursor));
  const snapshot = await query.get();
  const summary = { scanned: 0, projected: 0, eligible: 0, linked: 0, skippedDeclined: 0, invalidPhone: 0 };

  for (const document of snapshot.docs) {
    summary.scanned += 1;
    const data = document.data() || {};
    if (!dryRun) {
      await db.collection(PUBLIC_APPOINTMENT_COLLECTION).doc(document.id).set(
        sanitizeAppointmentForCalendar(data),
        { merge: false }
      );
      summary.projected += 1;
    }
    if (!normalizePhone(data.phone)) {
      summary.invalidPhone += 1;
      continue;
    }
    const allowCreate = canCreateIdentityFromAppointment(data);
    const existingIdentity = await getPhoneIdentity(normalizePhone(data.phone));
    if (!allowCreate && !existingIdentity) {
      summary.skippedDeclined += 1;
      continue;
    }
    summary.eligible += 1;
    if (!dryRun) {
      const result = await linkAppointmentIdentity(document.id, data, { allowCreate });
      if (result.linked) summary.linked += 1;
    }
  }

  await db.collection(CLIENT_AUDIT_COLLECTION).add({
    uid,
    kind: "backfill",
    dryRun,
    ...summary,
    createdAt: FieldValue.serverTimestamp()
  });
  return {
    ok: true,
    dryRun,
    ...summary,
    nextCursor: snapshot.docs.length === pageSize ? snapshot.docs[snapshot.docs.length - 1].id : null
  };
});

exports.syncAppointmentPrivacy = onDocumentWritten(
  triggerOptions("appointments/{appointmentId}"),
  async event => {
    const appointmentId = event.params.appointmentId;
    const after = event.data?.after;
    if (!after?.exists) {
      await Promise.all([
        db.collection(PUBLIC_APPOINTMENT_COLLECTION).doc(appointmentId).delete().catch(() => {}),
        db.collection(PRIVATE_APPOINTMENT_COLLECTION).doc(appointmentId).delete().catch(() => {})
      ]);
      return;
    }

    const data = after.data() || {};
    await db.collection(PUBLIC_APPOINTMENT_COLLECTION).doc(appointmentId).set(
      sanitizeAppointmentForCalendar(data),
      { merge: false }
    );
    if (!normalizePhone(data.phone)) {
      await db.collection(PRIVATE_APPOINTMENT_COLLECTION).doc(appointmentId).delete().catch(() => {});
      return;
    }
    await linkAppointmentIdentity(appointmentId, data, {
      allowCreate: canCreateIdentityFromAppointment(data)
    });
  }
);

exports.syncActivityLogPrivacy = onDocumentWritten(
  triggerOptions("activityLog/{logId}"),
  async event => {
    const logId = event.params.logId;
    const after = event.data?.after;
    if (!after?.exists) {
      await Promise.all([
        db.collection(PUBLIC_ACTIVITY_COLLECTION).doc(logId).delete().catch(() => {}),
        db.collection(PRIVATE_ACTIVITY_COLLECTION).doc(logId).delete().catch(() => {})
      ]);
      return;
    }
    const data = after.data() || {};
    const normalizedPhone = normalizePhone(data.phone);
    await db.collection(PUBLIC_ACTIVITY_COLLECTION).doc(logId).set(sanitizeActivityLog(data), { merge: false });
    if (normalizedPhone) {
      await db.collection(PRIVATE_ACTIVITY_COLLECTION).doc(logId).set({
        phoneNormalized: normalizedPhone,
        phoneDisplay: String(data.phone || normalizedPhone),
        phoneLast4: phoneLast4(normalizedPhone),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  }
);
