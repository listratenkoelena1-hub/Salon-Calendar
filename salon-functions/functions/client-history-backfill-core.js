"use strict";

const {
  normalizeClientName,
  normalizePhone,
  stripPrivateAppointmentFields
} = require("./client-history-core");
const {
  APPOINTMENT_PRIVATE_COLLECTION,
  CLIENT_HISTORY_COLLECTION,
  CLIENT_SCHEMA_VERSION,
  applyClientIdentityPlan,
  planClientIdentityInTransaction,
  writeClientAppointmentRecords
} = require("./client-history-store");

function isOnlineBookingAppointment(appointment) {
  return appointment?.source === "online_booking" ||
    appointment?.source === "onlineBooking" ||
    appointment?.type === "online_booking_request";
}

function classifyBackfillAppointment(appointment) {
  const publicPhone = String(appointment?.phone || "").trim();
  const version = Number(appointment?.privacySchemaVersion) || 0;
  const privateFlag = appointment?.hasPrivateContact === true;
  const booking = isOnlineBookingAppointment(appointment);

  if (version >= CLIENT_SCHEMA_VERSION || privateFlag) {
    return {
      status: publicPhone ? "inconsistent-public-phone" : "already-versioned",
      booking
    };
  }
  if (!publicPhone) return { status: "without-phone", booking };

  const phoneNormalized = normalizePhone(publicPhone);
  if (!phoneNormalized) return { status: "invalid-phone", booking };
  const nameNormalized = normalizeClientName(appointment?.client);
  if (!nameNormalized) return { status: "missing-name", booking };

  return {
    status: "candidate",
    booking,
    phoneNormalized,
    nameNormalized
  };
}

function summarizeBackfillAppointments(appointments) {
  const counts = {
    total: 0,
    booking: 0,
    candidate: 0,
    candidateBooking: 0,
    candidateOther: 0,
    withoutPhone: 0,
    invalidPhone: 0,
    missingName: 0,
    alreadyVersioned: 0,
    inconsistentPublicPhone: 0,
    distinctCandidatePhones: 0,
    distinctCandidatePhoneNames: 0
  };
  const phones = new Set();
  const phoneNames = new Set();

  for (const appointment of appointments || []) {
    counts.total += 1;
    const result = classifyBackfillAppointment(appointment);
    if (result.booking) counts.booking += 1;
    if (result.status === "candidate") {
      counts.candidate += 1;
      if (result.booking) counts.candidateBooking += 1;
      else counts.candidateOther += 1;
      phones.add(result.phoneNormalized);
      phoneNames.add(`${result.phoneNormalized}\u0000${result.nameNormalized}`);
    } else if (result.status === "without-phone") {
      counts.withoutPhone += 1;
    } else if (result.status === "invalid-phone") {
      counts.invalidPhone += 1;
    } else if (result.status === "missing-name") {
      counts.missingName += 1;
    } else if (result.status === "already-versioned") {
      counts.alreadyVersioned += 1;
    } else {
      counts.inconsistentPublicPhone += 1;
    }
  }

  counts.distinctCandidatePhones = phones.size;
  counts.distinctCandidatePhoneNames = phoneNames.size;
  return counts;
}

async function migrateLegacyAppointmentInTransaction({
  transaction,
  db,
  FieldValue,
  appointmentId,
  pepper
}) {
  const appointmentRef = db.collection("appointments").doc(String(appointmentId));
  const privateRef = db.collection(APPOINTMENT_PRIVATE_COLLECTION).doc(String(appointmentId));
  const historyRef = db.collection(CLIENT_HISTORY_COLLECTION).doc(String(appointmentId));
  const appointmentSnapshot = await transaction.get(appointmentRef);
  if (!appointmentSnapshot.exists) return { status: "missing" };

  const before = appointmentSnapshot.data() || {};
  const classification = classifyBackfillAppointment(before);
  if (classification.status === "already-versioned") {
    if (before.hasPrivateContact === true) {
      const privateSnapshot = await transaction.get(privateRef);
      if (!privateSnapshot.exists) throw new Error("A versioned appointment has no private contact.");
    }
    return { status: "already-versioned" };
  }
  if (classification.status !== "candidate") {
    if (classification.status === "inconsistent-public-phone") {
      throw new Error("A versioned appointment still exposes a public phone.");
    }
    return { status: classification.status };
  }

  const privateSnapshot = await transaction.get(privateRef);
  const historySnapshot = await transaction.get(historyRef);
  if (privateSnapshot.exists || historySnapshot.exists) {
    throw new Error("A legacy appointment already has unexpected private records.");
  }
  const identity = await planClientIdentityInTransaction({
    transaction,
    db,
    FieldValue,
    pepper,
    phone: before.phone,
    clientName: before.client,
    allowCreate: true,
    // Historic shared phones can belong to different people; never merge names
    // based on a fuzzy guess during an unattended backfill.
    allowCloseNameMatch: false
  });
  if (!identity?.clientProfileId) throw new Error("A client profile could not be created.");

  const after = stripPrivateAppointmentFields({
    ...before,
    privacySchemaVersion: CLIENT_SCHEMA_VERSION,
    hasPrivateContact: true
  });
  applyClientIdentityPlan(transaction, identity, FieldValue);
  transaction.set(appointmentRef, after);
  writeClientAppointmentRecords(transaction, {
    db,
    FieldValue,
    appointmentId: String(appointmentId),
    appointment: after,
    identity
  });
  return {
    status: "migrated",
    booking: classification.booking,
    createdClient: identity.createdClient,
    createdProfile: identity.createdProfile
  };
}

module.exports = {
  classifyBackfillAppointment,
  isOnlineBookingAppointment,
  migrateLegacyAppointmentInTransaction,
  summarizeBackfillAppointments
};
