"use strict";

const {
  chooseProfileMatch,
  getPhoneLast4,
  getServiceFingerprint,
  hashPhone,
  normalizeClientName,
  normalizePhone,
  parseServiceIntent,
  summarizeClientHistory
} = require("./client-history-core");

const CLIENT_COLLECTION = "clientLookup";
const CLIENT_PROFILE_COLLECTION = "clientProfiles";
const CLIENT_PHONE_INDEX_COLLECTION = "clientPhoneIndex";
const APPOINTMENT_PRIVATE_COLLECTION = "appointmentPrivate";
const CLIENT_HISTORY_COLLECTION = "clientAppointmentHistory";
const CLIENT_SCHEMA_VERSION = 1;
const CLIENT_SUMMARY_VERSION = 1;
const HISTORY_READ_LIMIT = 120;

function uniqueStrings(values, limit = 30) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || "").trim())
    .filter(Boolean))].slice(0, limit);
}

async function readProfiles(transaction, db, profileIds) {
  const ids = uniqueStrings(profileIds, 30);
  const profiles = [];
  for (const id of ids) {
    const snapshot = await transaction.get(db.collection(CLIENT_PROFILE_COLLECTION).doc(id));
    if (snapshot.exists) profiles.push({ id: snapshot.id, ...snapshot.data() });
  }
  return profiles;
}

function buildNewProfileData(clientId, displayName, FieldValue) {
  const normalizedName = normalizeClientName(displayName);
  return {
    schemaVersion: CLIENT_SCHEMA_VERSION,
    clientId,
    displayName: String(displayName || "").trim(),
    nameNormalized: normalizedName,
    aliases: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
}

async function planClientIdentityInTransaction({
  transaction,
  db,
  FieldValue,
  pepper,
  phone,
  clientName,
  allowCreate = true,
  allowCloseNameMatch = true,
  selectedProfileId = ""
}) {
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return null;

  const phoneKey = hashPhone(phoneNormalized, pepper);
  if (!phoneKey) throw new Error("Client lookup pepper is required.");
  const phoneIndexRef = db.collection(CLIENT_PHONE_INDEX_COLLECTION).doc(phoneKey);
  const phoneIndexSnapshot = await transaction.get(phoneIndexRef);

  let clientRef = null;
  let clientData = null;
  let createdClient = false;
  if (phoneIndexSnapshot.exists && phoneIndexSnapshot.data()?.clientId) {
    clientRef = db.collection(CLIENT_COLLECTION).doc(String(phoneIndexSnapshot.data().clientId));
    const clientSnapshot = await transaction.get(clientRef);
    if (!clientSnapshot.exists) {
      throw new Error("Client phone index points to a missing client record.");
    }
    clientData = clientSnapshot.data() || {};
  } else {
    if (!allowCreate) return null;
    clientRef = db.collection(CLIENT_COLLECTION).doc();
    clientData = {};
    createdClient = true;
  }

  const profiles = createdClient
    ? []
    : await readProfiles(transaction, db, clientData.profileIds);
  const normalizedName = normalizeClientName(clientName);
  let profile = null;
  let match = null;
  let ambiguous = false;

  if (selectedProfileId) {
    profile = profiles.find(item => item.id === String(selectedProfileId)) || null;
    if (!profile) throw new Error("Selected client profile does not belong to this phone number.");
    match = { type: "selected", distance: 0, score: 1 };
  } else if (normalizedName) {
    const choice = chooseProfileMatch(normalizedName, profiles, { allowClose: allowCloseNameMatch });
    profile = choice?.profile || null;
    match = choice?.match || null;
    ambiguous = choice?.ambiguous === true;
  }

  let profileRef = profile?.id
    ? db.collection(CLIENT_PROFILE_COLLECTION).doc(profile.id)
    : null;
  let profileData = profile;
  let createdProfile = false;
  if (!profileRef && normalizedName && allowCreate) {
    profileRef = db.collection(CLIENT_PROFILE_COLLECTION).doc();
    profileData = { id: profileRef.id, ...buildNewProfileData(clientRef.id, clientName, FieldValue) };
    createdProfile = true;
    match = { type: ambiguous ? "new_after_ambiguous" : "new", distance: null, score: 0 };
  }

  const displayPhone = String(phone || phoneNormalized).trim();
  const alias = !createdProfile && profileData && normalizedName &&
    normalizedName !== normalizeClientName(profileData.displayName) &&
    !(Array.isArray(profileData.aliases) && profileData.aliases.some(value => normalizeClientName(value) === normalizedName))
      ? String(clientName || "").trim()
      : "";

  return {
    phoneNormalized,
    phoneDisplay: displayPhone,
    phoneLast4: getPhoneLast4(phoneNormalized),
    phoneKey,
    phoneIndexRef,
    clientRef,
    clientData,
    clientId: clientRef.id,
    profileRef,
    profileData,
    clientProfileId: profileRef?.id || null,
    createdClient,
    createdProfile,
    alias,
    matchType: match?.type || "phone_only"
  };
}

function applyClientIdentityPlan(transaction, plan, FieldValue) {
  if (!plan) return;
  const now = FieldValue.serverTimestamp();

  if (plan.createdClient) {
    transaction.set(plan.phoneIndexRef, {
      schemaVersion: CLIENT_SCHEMA_VERSION,
      clientId: plan.clientId,
      createdAt: now,
      updatedAt: now
    });
    transaction.set(plan.clientRef, {
      schemaVersion: CLIENT_SCHEMA_VERSION,
      phoneNormalized: plan.phoneNormalized,
      phoneDisplay: plan.phoneDisplay,
      phoneLast4: plan.phoneLast4,
      phoneHash: plan.phoneKey,
      profileIds: plan.clientProfileId ? [plan.clientProfileId] : [],
      createdAt: now,
      updatedAt: now
    });
  } else if (plan.createdProfile) {
    transaction.set(plan.clientRef, {
      profileIds: FieldValue.arrayUnion(plan.clientProfileId),
      updatedAt: now
    }, { merge: true });
  }

  if (plan.createdProfile && plan.profileRef) {
    transaction.set(plan.profileRef, plan.profileData);
  } else if (plan.profileRef && plan.alias) {
    transaction.set(plan.profileRef, {
      aliases: uniqueStrings([
        ...(Array.isArray(plan.profileData?.aliases) ? plan.profileData.aliases : []),
        plan.alias
      ], 30),
      lastLinkedAt: now,
      updatedAt: now
    }, { merge: true });
  }
}

async function loadClientHistoryInTransaction(transaction, db, clientProfileId, limit = HISTORY_READ_LIMIT) {
  if (!clientProfileId) return [];
  const snapshot = await transaction.get(
    db.collection(CLIENT_HISTORY_COLLECTION)
      .where("clientProfileId", "==", String(clientProfileId))
      .limit(Math.max(1, Math.min(HISTORY_READ_LIMIT, Number(limit) || HISTORY_READ_LIMIT)))
  );
  return snapshot.docs.map(document => ({ id: document.id, ...document.data() }));
}

async function readClientIdentity({ db, pepper, phone, clientName, allowCloseNameMatch = true }) {
  const phoneClient = await readPhoneClient({ db, pepper, phone });
  const normalizedName = normalizeClientName(clientName);
  if (!phoneClient || !normalizedName) return null;
  const {
    clientId,
    client,
    profiles,
    phoneKey,
    phoneNormalized
  } = phoneClient;
  const choice = chooseProfileMatch(normalizedName, profiles, { allowClose: allowCloseNameMatch });
  if (!choice?.profile) {
    return {
      clientId,
      client,
      profile: null,
      profiles,
      ambiguous: choice?.ambiguous === true,
      phoneKey,
      phoneNormalized
    };
  }
  return {
    clientId,
    client,
    profile: choice.profile,
    profiles,
    match: choice.match,
    ambiguous: false,
    phoneKey,
    phoneNormalized
  };
}

async function readPhoneClient({ db, pepper, phone }) {
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return null;
  const phoneKey = hashPhone(phoneNormalized, pepper);
  if (!phoneKey) throw new Error("Client lookup pepper is required.");

  const indexSnapshot = await db.collection(CLIENT_PHONE_INDEX_COLLECTION).doc(phoneKey).get();
  if (!indexSnapshot.exists || !indexSnapshot.data()?.clientId) return null;
  const clientId = String(indexSnapshot.data().clientId);
  const clientSnapshot = await db.collection(CLIENT_COLLECTION).doc(clientId).get();
  if (!clientSnapshot.exists) return null;
  const clientData = clientSnapshot.data() || {};
  const profileIds = uniqueStrings(clientData.profileIds, 30);
  const profileSnapshots = profileIds.length
    ? await db.getAll(...profileIds.map(id => db.collection(CLIENT_PROFILE_COLLECTION).doc(id)))
    : [];
  const profiles = profileSnapshots
    .filter(snapshot => snapshot.exists)
    .map(snapshot => ({ id: snapshot.id, ...snapshot.data() }));

  return {
    clientId,
    client: { id: clientId, ...clientData },
    profiles,
    phoneKey,
    phoneNormalized
  };
}

async function readClientContext({ db, pepper, phone, clientName, allowCloseNameMatch = true }) {
  const identity = await readClientIdentity({ db, pepper, phone, clientName, allowCloseNameMatch });
  if (!identity?.profile?.id) return identity ? { ...identity, history: [], summary: null } : null;
  const cachedSummary = getCachedProfileSummary(identity.profile);
  if (cachedSummary) return { ...identity, history: [], summary: cachedSummary, summarySource: "profile" };
  const historySnapshot = await db.collection(CLIENT_HISTORY_COLLECTION)
    .where("clientProfileId", "==", identity.profile.id)
    .limit(HISTORY_READ_LIMIT)
    .get();
  const history = historySnapshot.docs.map(document => ({ id: document.id, ...document.data() }));
  return { ...identity, history, summary: summarizeClientHistory(history), summarySource: "history" };
}

function getCachedProfileSummary(profile) {
  if (Number(profile?.historySummaryVersion) !== CLIENT_SUMMARY_VERSION) return null;
  const summary = profile?.historySummary;
  return summary && typeof summary === "object" && !Array.isArray(summary) ? summary : null;
}

function invalidateClientProfileSummary(transaction, db, FieldValue, clientProfileId) {
  const profileId = String(clientProfileId || "");
  if (!profileId) return;
  transaction.set(db.collection(CLIENT_PROFILE_COLLECTION).doc(profileId), {
    historySummaryVersion: 0,
    historySummaryDirtyAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

function buildAppointmentPrivateData(appointmentId, appointment, identity, FieldValue) {
  if (!identity) return null;
  return {
    schemaVersion: CLIENT_SCHEMA_VERSION,
    appointmentId,
    clientId: identity.clientId,
    clientProfileId: identity.clientProfileId,
    phoneNormalized: identity.phoneNormalized,
    phoneDisplay: identity.phoneDisplay,
    phoneLast4: identity.phoneLast4,
    phoneHash: identity.phoneKey,
    clientNameNormalized: normalizeClientName(appointment?.client),
    source: String(appointment?.source || "calendar"),
    updatedAt: FieldValue.serverTimestamp()
  };
}

function buildClientHistoryData(appointmentId, appointment, identity, FieldValue) {
  if (!identity?.clientProfileId) return null;
  const serviceIntent = appointment?.serviceIntent || parseServiceIntent({
    selectedServices: appointment?.selectedServices,
    serviceDetails: appointment?.note || ""
  });
  const standardDuration = Number(
    appointment?.standardDuration ?? appointment?.bookingStandardDuration ?? appointment?.duration
  );
  return {
    schemaVersion: CLIENT_SCHEMA_VERSION,
    appointmentId,
    clientId: identity.clientId,
    clientProfileId: identity.clientProfileId,
    date: String(appointment?.date || ""),
    start: Number(appointment?.start) || 0,
    staffId: String(appointment?.staffId || ""),
    client: String(appointment?.client || ""),
    note: String(appointment?.note || ""),
    selectedServices: Array.isArray(appointment?.selectedServices) ? appointment.selectedServices.slice(0, 12) : [],
    serviceIntent,
    serviceFingerprint: appointment?.serviceFingerprint || getServiceFingerprint(serviceIntent),
    standardDuration: Number.isInteger(standardDuration) && standardDuration > 0 ? standardDuration : null,
    duration: Number(appointment?.duration) || 0,
    status: String(appointment?.status || ""),
    type: String(appointment?.type || ""),
    source: String(appointment?.source || "calendar"),
    noShow: appointment?.noShow === true,
    canceled: appointment?.canceled === true,
    lastAction: String(appointment?.lastAction || ""),
    historyEligible: !["request", "requested", "pending", "declined"].includes(String(appointment?.status || "").toLowerCase()) &&
      appointment?.lastAction !== "online_request_created" &&
      appointment?.lastAction !== "online_request_declined",
    updatedAt: FieldValue.serverTimestamp()
  };
}

function writeClientAppointmentRecords(transaction, {
  db,
  FieldValue,
  appointmentId,
  appointment,
  identity
}) {
  const privateRef = db.collection(APPOINTMENT_PRIVATE_COLLECTION).doc(appointmentId);
  const historyRef = db.collection(CLIENT_HISTORY_COLLECTION).doc(appointmentId);
  const privateData = buildAppointmentPrivateData(appointmentId, appointment, identity, FieldValue);
  const historyData = buildClientHistoryData(appointmentId, appointment, identity, FieldValue);
  if (!privateData) {
    transaction.delete(privateRef);
    transaction.delete(historyRef);
    return;
  }
  transaction.set(privateRef, privateData, { merge: true });
  if (historyData) transaction.set(historyRef, historyData, { merge: true });
  else transaction.delete(historyRef);
  invalidateClientProfileSummary(transaction, db, FieldValue, identity.clientProfileId);
}

function deleteClientAppointmentRecords(transaction, db, appointmentId) {
  transaction.delete(db.collection(APPOINTMENT_PRIVATE_COLLECTION).doc(appointmentId));
  transaction.delete(db.collection(CLIENT_HISTORY_COLLECTION).doc(appointmentId));
}

module.exports = {
  APPOINTMENT_PRIVATE_COLLECTION,
  CLIENT_COLLECTION,
  CLIENT_HISTORY_COLLECTION,
  CLIENT_PHONE_INDEX_COLLECTION,
  CLIENT_PROFILE_COLLECTION,
  CLIENT_SCHEMA_VERSION,
  CLIENT_SUMMARY_VERSION,
  applyClientIdentityPlan,
  buildAppointmentPrivateData,
  buildClientHistoryData,
  deleteClientAppointmentRecords,
  getCachedProfileSummary,
  invalidateClientProfileSummary,
  loadClientHistoryInTransaction,
  planClientIdentityInTransaction,
  readClientContext,
  readClientIdentity,
  readPhoneClient,
  writeClientAppointmentRecords
};
