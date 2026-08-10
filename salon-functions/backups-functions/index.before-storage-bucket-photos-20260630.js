const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } =
require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const admin = require("firebase-admin");
const fetch = require("node-fetch");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const ANYONE_ID = "anyone";
const SLOT_COUNT = 49;
const ANYONE_DISPLAY_DURATION = 1;
const ANYONE_REQUIRED_DURATION = 4;
const MAX_PHOTO_LINKS = 2;
const MAX_REQUEST_TEXT = 1200;
const BOOKING_DURATION = 4;
const BOOKING_SERVICE_GROUPS = ["manicure", "pedicure", "acrylics", "brows", "waxing", "lashes"];
const DEFAULT_BOOKING_SERVICE_GROUPS = ["manicure", "pedicure"];
const MAX_PHOTO_UPLOADS = 2;
const MAX_PHOTO_BYTES = 1250000;
const PHOTO_TTL_MS = 24 * 60 * 60 * 1000;
const PHOTO_COLLECTION = "onlineBookingPhotos";
const PHOTO_STORAGE_PREFIX = "online-booking-photos";
const PHOTO_REVIEW_BASE_URL = "https://rosesnails-calendar.web.app/booking-photo";
const PHOTO_CHUNK_SIZE = 700000;

/* === ÐÐÐ¡Ð¢Ð ÐžÐ™ÐšÐ˜ TELEGRAM === */
const BOT_TOKEN = "8570779845:AAHbb2LI4judUopNFDiMN3-gXmLzusRe9JE";

// ===== TELEGRAM MODE =====
// test â†’ ÑÐ¾Ð¾Ð±Ñ‰ÐµÐ½Ð¸Ñ Ð¸Ð´ÑƒÑ‚ Ñ‚Ð¾Ð»ÑŒÐºÐ¾ Ñ‚ÐµÐ±Ðµ
// prod â†’ ÑÐ¾Ð¾Ð±Ñ‰ÐµÐ½Ð¸Ñ Ð¸Ð´ÑƒÑ‚ Ð² Ð¾Ð±Ñ‰Ð¸Ð¹ Ñ‡Ð°Ñ‚ ÑÐ°Ð»Ð¾Ð½Ð°
const TELEGRAM_MODE = "prod";

const TELEGRAM_CHAT_PROD = "-1003851620923"; // Ð¾Ð±Ñ‰Ð¸Ð¹ Ñ‡Ð°Ñ‚ ÑÐ°Ð»Ð¾Ð½Ð°
const TELEGRAM_CHAT_TEST = "1864541569";     // Ñ‚Ð²Ð¾Ð¹ Ð»Ð¸Ñ‡Ð½Ñ‹Ð¹ Telegram ID

const CHAT_ID =
  TELEGRAM_MODE === "test"
    ? TELEGRAM_CHAT_TEST
    : TELEGRAM_CHAT_PROD;

/* === Ð’Ð¡ÐŸÐžÐœÐžÐ“ÐÐ¢Ð•Ð›Ð¬ÐÐ«Ð• Ð¤Ð£ÐÐšÐ¦Ð˜Ð˜ === */

// ÑÐ»Ð¾Ñ‚ â†’ Ð²Ñ€ÐµÐ¼Ñ (Ñ 08:00, ÑˆÐ°Ð³ 15 Ð¼Ð¸Ð½)
function slotToTime(slot) {

if (slot >= 48) {
  return "8:00 PM";
}

const totalMinutes = 8 * 60 + slot * 15;
let hours = Math.floor(totalMinutes / 60);
const minutes = totalMinutes % 60;

const ampm = hours >= 12 ? "PM" : "AM";
hours = hours % 12 || 12;

return `${hours}:${minutes.toString().padStart(2, "0")} ${ampm}`;
}

// Ð´Ð»Ð¸Ñ‚ÐµÐ»ÑŒÐ½Ð¾ÑÑ‚ÑŒ Ð² HH:MM Ð¸Ð»Ð¸ Ð¿Ñ€Ð¾Ñ‡ÐµÑ€Ðº Ð´Ð»Ñ Anyone
function formatDuration(slots, staffName) {
if (staffName === "Anyone") return "â€”";
const minutes = slots * 15;
const h = Math.floor(minutes / 60);
const m = minutes % 60;
return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}
function formatMoney(cents) {
const value = Number(cents) || 0;
return `$${(value / 100).toFixed(2)}`;
}
function wait(ms) {
return new Promise(resolve => setTimeout(resolve, ms));
}

function assertString(value, field, { min = 0, max = 500 } = {}) {
  const text = String(value || "").trim();
  if (text.length < min) {
    throw new HttpsError("invalid-argument", `${field} is required.`);
  }
  if (text.length > max) {
    throw new HttpsError("invalid-argument", `${field} is too long.`);
  }
  return text;
}

function assertDate(value) {
  const date = assertString(value, "date", { min: 10, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError("invalid-argument", "Invalid date.");
  }
  return date;
}

function assertSlot(value) {
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    throw new HttpsError("invalid-argument", "Invalid time.");
  }
  return slot;
}

function getSalonBookingHours(dateStr) {
  const weekday = getLocalDate(dateStr).getDay();
  if (weekday === 0 || weekday === 6) {
    return { start: 8, end: 40 }; // 10:00 AM - 6:00 PM
  }
  return { start: 8, end: 48 }; // 10:00 AM - 8:00 PM
}

function normalizeServiceGroups(value) {
  const raw = Array.isArray(value) ? value : [value];
  const groups = [];

  raw.forEach(item => {
    const normalized = String(item || "").trim().toLowerCase();
    if (!normalized) return;
    if (["nail", "nails"].includes(normalized)) {
      groups.push("manicure", "pedicure");
      return;
    }
    if (["mani", "manicure"].includes(normalized)) groups.push("manicure");
    else if (["pedi", "pedicure"].includes(normalized)) groups.push("pedicure");
    else if (["acrylic", "acrylics"].includes(normalized)) groups.push("acrylics");
    else if (["brow", "brows", "eyebrow", "eyebrows"].includes(normalized)) groups.push("brows");
    else if (["wax", "waxing"].includes(normalized)) groups.push("waxing");
    else if (["lash", "lashes", "eyelash", "eyelashes"].includes(normalized)) groups.push("lashes");
    else if (BOOKING_SERVICE_GROUPS.includes(normalized)) groups.push(normalized);
  });

  return [...new Set(groups)];
}

function inferServiceGroupsFromText(text) {
  const normalized = String(text || "").toLowerCase();
  const groups = [];

  if (/brow|eyebrow|tint/.test(normalized)) groups.push("brows");
  if (/lash|eyelash/.test(normalized)) groups.push("lashes");
  if (/wax|waxing/.test(normalized)) groups.push("waxing");
  if (/acrylic/.test(normalized)) groups.push("acrylics");
  if (/pedicure|\bpedi\b/.test(normalized)) groups.push("pedicure");
  if (/manicure|\bmani\b|nail|gel|shellac|french|design/.test(normalized)) groups.push("manicure");

  return [...new Set(groups)];
}

function getRequestedServiceGroups(input = {}) {
  const explicitGroups = normalizeServiceGroups(input.serviceGroups || input.selectedServiceGroups);
  if (explicitGroups.length) return explicitGroups;

  const selectedText = Array.isArray(input.selectedServices)
    ? input.selectedServices.join(" ")
    : "";
  const inferred = inferServiceGroupsFromText(`${selectedText} ${input.serviceDetails || ""}`);
  return inferred.length ? inferred : [...DEFAULT_BOOKING_SERVICE_GROUPS];
}

function getStaffServiceGroups(staffRecord) {
  const configured = normalizeServiceGroups(
    staffRecord?.bookingServiceGroups ||
    staffRecord?.serviceGroups ||
    staffRecord?.services
  );
  return configured.length ? configured : [...DEFAULT_BOOKING_SERVICE_GROUPS];
}

function staffCanDoServiceGroups(staffRecord, requestedGroups) {
  const staffGroups = getStaffServiceGroups(staffRecord);
  return requestedGroups.every(group => staffGroups.includes(group));
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

function getLocalDate(dateStr) {
  const [year, month, day] = String(dateStr || "").split("-").map(Number);
  return new Date(year, month - 1, day);
}

function isWeeklyRuleActiveOnDate(rule, dateStr) {
  if (rule.enabled === false) return false;

  const checkDate = getLocalDate(dateStr);

  if (rule.startDate && checkDate < getLocalDate(rule.startDate)) return false;
  if (rule.endDate && checkDate > getLocalDate(rule.endDate)) return false;

  return true;
}

function hasWeeklyExceptionForDate(offWorkRecords, weeklyId, dateStr) {
  return offWorkRecords.some(o =>
    o.weeklyException === true &&
    o.weeklyId === weeklyId &&
    o.date === dateStr
  );
}

function getOffWorkOccurrencesForDate({ offWorkRecords, weeklyOffRecords, date, staffId }) {
  const selectedDate = getLocalDate(date);
  const weekday = selectedDate.getDay();

  const manual = offWorkRecords
    .filter(o => {
      if (o.weeklyException === true) return false;
      if (o.date !== date) return false;
      if (o.staffId !== staffId) return false;
      return true;
    })
    .map(o => ({
      allDay: o.allDay === true,
      start: o.allDay === true ? 0 : Number(o.start),
      end: o.allDay === true ? SLOT_COUNT : Number(o.end)
    }));

  const weekly = weeklyOffRecords
    .filter(w => {
      if (w.enabled === false) return false;
      if (w.staffId !== staffId) return false;
      if (Number(w.weekday) !== weekday) return false;
      if (!isWeeklyRuleActiveOnDate(w, date)) return false;
      if (hasWeeklyExceptionForDate(offWorkRecords, w.id, date)) return false;
      return true;
    })
    .map(w => ({
      allDay: w.allDay === true,
      start: w.allDay === true ? 0 : Number(w.start),
      end: w.allDay === true ? SLOT_COUNT : Number(w.end)
    }));

  return weekly.concat(manual);
}

function isActiveAppointment(a) {
  return a && a.noShow !== true && a.canceled !== true;
}

function appointmentBlocksStaff(a, staffId, date, start, end) {
  if (!isActiveAppointment(a)) return false;
  if (a.staffId !== staffId) return false;
  if (a.date !== date) return false;
  const appointmentStart = Number(a.start);
  const appointmentEnd = appointmentStart + Math.max(Number(a.duration) || 1, 1);
  return rangesOverlap(start, end, appointmentStart, appointmentEnd);
}

function staffHasOffWork(offWorkRecords, weeklyOffRecords, staffId, date, start, end) {
  return getOffWorkOccurrencesForDate({
    offWorkRecords,
    weeklyOffRecords,
    date,
    staffId
  }).some(o => o.allDay || rangesOverlap(start, end, o.start, o.end));
}

function realStaffAvailable({
  staffId,
  date,
  start,
  end,
  appointments,
  offWorkRecords,
  weeklyOffRecords
}) {
  if (!staffId || staffId === ANYONE_ID) return false;
  if (appointments.some(a => appointmentBlocksStaff(a, staffId, date, start, end))) return false;
  if (staffHasOffWork(offWorkRecords, weeklyOffRecords, staffId, date, start, end)) return false;
  return true;
}

function getAnyoneRemainingCapacity({
  date,
  start,
  appointments,
  staffRecords,
  offWorkRecords,
  weeklyOffRecords,
  requestedGroups = DEFAULT_BOOKING_SERVICE_GROUPS
}) {
  const end = start + ANYONE_REQUIRED_DURATION;
  const realStaff = staffRecords
    .filter(s => s.id && s.id !== ANYONE_ID)
    .filter(s => s.bookingEnabled !== false)
    .filter(s => staffCanDoServiceGroups(s, requestedGroups));
  const availableStaffCount = realStaff.filter(s => realStaffAvailable({
    staffId: s.id,
    date,
    start,
    end,
    appointments,
    offWorkRecords,
    weeklyOffRecords
  })).length;

  const existingAnyoneCount = appointments.filter(a => {
    if (!isActiveAppointment(a)) return false;
    if (a.staffId !== ANYONE_ID) return false;
    if (a.date !== date) return false;
    const anyoneStart = Number(a.start);
    return rangesOverlap(start, end, anyoneStart, anyoneStart + ANYONE_REQUIRED_DURATION);
  }).length;

  return availableStaffCount - existingAnyoneCount;
}

function getAvailabilityForDate({
  date,
  requestedGroups,
  appointments,
  staffRecords,
  offWorkRecords,
  weeklyOffRecords
}) {
  const hours = getSalonBookingHours(date);
  const realStaff = staffRecords
    .filter(s => s.id && s.id !== ANYONE_ID)
    .filter(s => s.bookingEnabled !== false)
    .map(s => ({
      id: s.id,
      name: s.name || "Staff",
      serviceGroups: getStaffServiceGroups(s),
      canDoRequestedServices: staffCanDoServiceGroups(s, requestedGroups)
    }));

  const times = [];

  for (let slot = hours.start; slot + BOOKING_DURATION <= hours.end; slot++) {
    const availableStaff = realStaff
      .filter(s => s.canDoRequestedServices)
      .filter(s => realStaffAvailable({
        staffId: s.id,
        date,
        start: slot,
        end: slot + BOOKING_DURATION,
        appointments,
        offWorkRecords,
        weeklyOffRecords
      }))
      .map(s => s.id);

    const anyoneRemainingCapacity = getAnyoneRemainingCapacity({
      date,
      start: slot,
      appointments,
      staffRecords: realStaff,
      offWorkRecords,
      weeklyOffRecords,
      requestedGroups
    });

    if (availableStaff.length || anyoneRemainingCapacity > 0) {
      times.push({
        slot,
        label: slotToTime(slot),
        availableStaff,
        anyoneAvailable: anyoneRemainingCapacity > 0,
        anyoneRemainingCapacity: Math.max(0, anyoneRemainingCapacity)
      });
    }
  }

  return {
    date,
    serviceGroups: requestedGroups,
    staff: realStaff,
    times
  };
}

function buildRequestNote({ selectedServices, serviceDetails }) {
  const parts = [];
  if (selectedServices.length) parts.push(`Selected: ${selectedServices.join(", ")}`);
  if (serviceDetails) parts.push(serviceDetails);
  return parts.join("\n").slice(0, MAX_REQUEST_TEXT);
}

function getStaffName(staffRecords, staffId) {
  if (staffId === ANYONE_ID) return "Anyone";
  return staffRecords.find(s => s.id === staffId)?.name || "Staff";
}

function buildOnlineBookingTelegramMessage(data, staffRecords) {
  const staffName = getStaffName(staffRecords, data.staffId);
  const noteLine = data.note ? `\n${data.note}` : "";
  const photoLine = data.photoReviewUrl ? `\nPhotos: <a href="${data.photoReviewUrl}">open temporary photos</a>` : "";
  return `ONLINE BOOKING REQUEST\n${data.client} requested <b>${staffName}</b> - <u>${formatDate(data.date)}</u> at <i>${slotToTime(data.start)}</i>.${noteLine}${photoLine}`;
}

function buildAppointmentLogDetails(data, staffRecords) {
  const staffName = getStaffName(staffRecords, data.staffId);
  const base = data.note ? `${data.client} - ${data.note}` : data.client;
  return `${base}; ${formatDate(data.date)}, at ${slotToTime(data.start)}; ${staffName}`;
}

// Ð´Ð°Ñ‚Ð° Ð±ÐµÐ· Ð³Ð¾Ð´Ð°: Friday, January 23
function formatDate(dateStr) {
const date = new Date(dateStr);
return date.toLocaleDateString("en-US", {
weekday: "long",
day: "numeric",
month: "long",
});
}

// Ð¾Ñ‚Ð¿Ñ€Ð°Ð²ÐºÐ° Ð² Telegram
async function sendTelegram(text) {
await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({
chat_id: CHAT_ID,
text,
parse_mode: "HTML",
}),
});
}

/* === TELEGRAM QUEUE TRIGGER (GEN 2) === */

exports.telegramQueueCreated = onDocumentCreated(
  "TelegramQueue/{id}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const ref = snap.ref;
    const data = snap.data() || {};

    if (data.status && data.status !== "pending") return;
    if (!data.message || typeof data.message !== "string") {
      await ref.set(
        {
          status: "skipped",
          skippedAt: admin.firestore.FieldValue.serverTimestamp(),
          error: "Missing message"
        },
        { merge: true }
      );
      return;
    }

    try {
      await sendTelegram(data.message);

      await ref.set(
        {
          status: "sent",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          error: admin.firestore.FieldValue.delete()
        },
        { merge: true }
      );
    } catch (error) {
      console.error("Telegram queue send error:", error);

      await ref.set(
        {
          status: "error",
          error: error && error.message ? error.message : String(error),
          failedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
  }
);


function getPhotoReviewUrl(token) {
  return `${PHOTO_REVIEW_BASE_URL}?t=${encodeURIComponent(token)}`;
}

function sanitizePhotoName(name, index) {
  const clean = String(name || `photo-${index + 1}.jpg`)
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 80);
  return clean || `photo-${index + 1}.jpg`;
}

function validatePhotoUploads(value) {
  const rawPhotos = Array.isArray(value) ? value.slice(0, MAX_PHOTO_UPLOADS) : [];
  return rawPhotos.map((photo, index) => {
    const dataUrl = String(photo?.dataUrl || "");
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      throw new HttpsError("invalid-argument", "Invalid photo format.");
    }

    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > MAX_PHOTO_BYTES) {
      throw new HttpsError("invalid-argument", "Photo is too large. Please upload a smaller photo.");
    }

    return {
      name: sanitizePhotoName(photo?.name, index),
      contentType: match[1],
      base64: buffer.toString("base64"),
      size: buffer.length
    };
  });
}

function splitPhotoBase64(base64) {
  const chunks = [];
  for (let index = 0; index < base64.length; index += PHOTO_CHUNK_SIZE) {
    chunks.push(base64.slice(index, index + PHOTO_CHUNK_SIZE));
  }
  return chunks;
}

async function storeOnlineBookingPhotos({ photos, appointmentId, requestId }) {
  if (!photos.length) return null;

  const token = crypto.randomBytes(24).toString("base64url");
  const reviewRef = db.collection(PHOTO_COLLECTION).doc(token);
  const expiresAtDate = new Date(Date.now() + PHOTO_TTL_MS);
  const reviewUrl = getPhotoReviewUrl(token);
  const files = [];
  const batch = db.batch();

  photos.forEach((photo, photoIndex) => {
    const chunks = splitPhotoBase64(photo.base64);
    files.push({
      name: photo.name,
      contentType: photo.contentType,
      size: photo.size,
      chunkCount: chunks.length
    });

    chunks.forEach((chunk, chunkIndex) => {
      batch.set(reviewRef.collection("chunks").doc(`${photoIndex}_${chunkIndex}`), {
        photoIndex,
        chunkIndex,
        name: photo.name,
        contentType: photo.contentType,
        data: chunk
      });
    });
  });

  batch.set(reviewRef, {
    token,
    appointmentId,
    requestId,
    status: "active",
    files,
    reviewUrl,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAtDate)
  });

  await batch.commit();

  return {
    token,
    url: reviewUrl,
    refs: files.map(file => ({ name: file.name, contentType: file.contentType, size: file.size }))
  };
}

async function deletePhotoChunks(token) {
  if (!token) return;
  const chunksSnap = await db.collection(PHOTO_COLLECTION).doc(token).collection("chunks").get();
  if (chunksSnap.empty) return;

  let batch = db.batch();
  let count = 0;
  for (const docSnap of chunksSnap.docs) {
    batch.delete(docSnap.ref);
    count += 1;
    if (count >= 450) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count) await batch.commit();
}

async function closePhotoReview(token, status) {
  if (!token) return;
  const ref = db.collection(PHOTO_COLLECTION).doc(token);
  const snap = await ref.get();
  if (!snap.exists) return;
  await deletePhotoChunks(token);
  await ref.set({
    status,
    closedAt: FieldValue.serverTimestamp(),
    filesDeletedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

async function readPhotoReviewChunks(token) {
  const chunksSnap = await db.collection(PHOTO_COLLECTION).doc(token).collection("chunks").get();
  const grouped = new Map();

  chunksSnap.docs.forEach(docSnap => {
    const chunk = docSnap.data() || {};
    const key = Number(chunk.photoIndex) || 0;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(chunk);
  });

  return Array.from(grouped.entries())
    .sort(([a], [b]) => a - b)
    .map(([, chunks]) => {
      chunks.sort((a, b) => (Number(a.chunkIndex) || 0) - (Number(b.chunkIndex) || 0));
      const first = chunks[0] || {};
      const base64 = chunks.map(chunk => chunk.data || "").join("");
      return {
        name: first.name || "photo.jpg",
        contentType: first.contentType || "image/jpeg",
        dataUrl: `data:${first.contentType || "image/jpeg"};base64,${base64}`
      };
    });
}
exports.createOnlineBookingRequest = onCall(
  {
    region: "us-central1",
    maxInstances: 5
  },
  async (request) => {
    const input = request.data || {};

    const requestId = assertString(input.requestId, "requestId", { min: 12, max: 80 });
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
      throw new HttpsError("invalid-argument", "Invalid requestId.");
    }

    const client = assertString(input.client, "client", { min: 2, max: 80 });
    const phone = assertString(input.phone, "phone", { min: 7, max: 30 });
    const date = assertDate(input.date);
    const start = assertSlot(input.start);
    const staffId = assertString(input.staffId || ANYONE_ID, "staffId", { min: 1, max: 80 });
    const selectedLanguage = assertString(input.selectedLanguage || "English", "selectedLanguage", { max: 40 });
    const serviceDetails = assertString(input.serviceDetails || "", "serviceDetails", { max: MAX_REQUEST_TEXT });
    const selectedServices = Array.isArray(input.selectedServices)
      ? input.selectedServices.map(item => String(item || "").trim()).filter(Boolean).slice(0, 12)
      : [];
    const requestedGroups = getRequestedServiceGroups(input);
    const uploadedPhotos = validatePhotoUploads(input.photos);

    if (input.consentAccepted !== true) {
      throw new HttpsError("invalid-argument", "Consent is required.");
    }

    if (!serviceDetails && !selectedServices.length) {
      throw new HttpsError("invalid-argument", "Service details are required.");
    }

    const requestedDate = getLocalDate(date);
    if (Number.isNaN(requestedDate.getTime())) {
      throw new HttpsError("invalid-argument", "Invalid date.");
    }

    const now = new Date();
    const requestedStart = new Date(requestedDate);
    requestedStart.setHours(8, 0, 0, 0);
    requestedStart.setMinutes(requestedStart.getMinutes() + start * 15);

    if (requestedStart.getTime() < now.getTime() + 3 * 60 * 60 * 1000) {
      throw new HttpsError("failed-precondition", "Please choose a time at least 3 hours ahead.");
    }

    const submissionRef = db.collection("onlineBookingSubmissions").doc(requestId);
    const appointmentRef = db.collection("appointments").doc();
    const logRef = db.collection("activityLog").doc();
    const telegramRef = db.collection("TelegramQueue").doc();
    let photoReview = null;

    try {
      const existingSubmissionSnap = await submissionRef.get();
      if (existingSubmissionSnap.exists) {
        const existing = existingSubmissionSnap.data() || {};
        return {
          ok: true,
          duplicate: true,
          appointmentId: existing.appointmentId || null
        };
      }

      photoReview = uploadedPhotos.length
        ? await storeOnlineBookingPhotos({ photos: uploadedPhotos, appointmentId: appointmentRef.id, requestId })
        : null;

      const result = await db.runTransaction(async tx => {
      const existingSubmission = await tx.get(submissionRef);
      if (existingSubmission.exists) {
        const existing = existingSubmission.data() || {};
        return {
          ok: true,
          duplicate: true,
          appointmentId: existing.appointmentId || null
        };
      }

      const staffSnap = await tx.get(db.collection("staff"));
      const staffRecords = staffSnap.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      }));

      const realStaffIds = new Set(staffRecords.map(s => s.id));
      if (staffId !== ANYONE_ID && !realStaffIds.has(staffId)) {
        throw new HttpsError("invalid-argument", "Selected technician is not available.");
      }

      const selectedStaff = staffRecords.find(s => s.id === staffId);
      if (
        staffId !== ANYONE_ID &&
        (!selectedStaff || !staffCanDoServiceGroups(selectedStaff, requestedGroups))
      ) {
        throw new HttpsError("failed-precondition", "Selected technician does not provide one of the requested services.");
      }

      const appointmentsSnap = await tx.get(
        db.collection("appointments").where("date", "==", date)
      );
      const appointments = appointmentsSnap.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      }));

      const offWorkSnap = await tx.get(
        db.collection("OffWork").where("date", "==", date)
      );
      const offWorkRecords = offWorkSnap.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      }));

      const weeklyOffSnap = await tx.get(db.collection("WeeklyOff"));
      const weeklyOffRecords = weeklyOffSnap.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      }));

      let duration = 4;
      if (staffId === ANYONE_ID) {
        duration = ANYONE_DISPLAY_DURATION;
        const remainingCapacity = getAnyoneRemainingCapacity({
          date,
          start,
          appointments,
          staffRecords,
          offWorkRecords,
          weeklyOffRecords,
          requestedGroups
        });

        if (remainingCapacity <= 0) {
          throw new HttpsError("failed-precondition", "This time is no longer available.");
        }
      } else {
        const end = start + duration;
        if (!realStaffAvailable({
          staffId,
          date,
          start,
          end,
          appointments,
          offWorkRecords,
          weeklyOffRecords
        })) {
          throw new HttpsError("failed-precondition", "This time is no longer available.");
        }
      }

      const appointmentData = {
        date,
        staffId,
        phone,
        start,
        duration,
        client,
        note: buildRequestNote({ selectedServices, serviceDetails }),
        noShow: false,
        canceled: false,
        cancelComment: null,
        type: "online_booking_request",
        source: "online_booking",
        status: "request",
        selectedLanguage,
        selectedServices,
        requestWarning: null,
        photoRefs: photoReview ? photoReview.refs : [],
        photoLinks: photoReview ? [photoReview.url] : [],
        photoReviewToken: photoReview ? photoReview.token : null,
        photoReviewUrl: photoReview ? photoReview.url : null,
        consentAccepted: true,
        consentAcceptedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        lastEditedBy: "Online Booking",
        lastAction: "online_request_created",
        lastActionAt: FieldValue.serverTimestamp()
      };

      tx.set(appointmentRef, appointmentData);
      tx.set(submissionRef, {
        appointmentId: appointmentRef.id,
        createdAt: FieldValue.serverTimestamp(),
        status: "created"
      });

      tx.set(logRef, {
        createdAt: FieldValue.serverTimestamp(),
        logDate: date,
        actorLabel: "Online Booking",
        actorKey: "online_booking",
        staffId,
        eventType: "online_request_created",
        entityType: "appointment",
        client,
        phone,
        service: appointmentData.note,
        details: buildAppointmentLogDetails(appointmentData, staffRecords)
      });

      tx.set(telegramRef, {
        status: "pending",
        message: buildOnlineBookingTelegramMessage(appointmentData, staffRecords),
        eventType: "online_request_created",
        entityType: "appointment",
        entityId: appointmentRef.id,
        staffId,
        staffName: getStaffName(staffRecords, staffId),
        actorLabel: "Online Booking",
        actorKey: "online_booking",
        createdAt: FieldValue.serverTimestamp(),
        source: "online_booking"
      });

      return {
        ok: true,
        duplicate: false,
        appointmentId: appointmentRef.id
      };
    });
      return result;
    } catch (error) {
      if (photoReview?.token) {
        await closePhotoReview(photoReview.token, "abandoned");
      }
      throw error;
    }
  }
);

exports.getOnlineBookingPhotos = onCall(
  {
    region: "us-central1",
    maxInstances: 5
  },
  async (request) => {
    const token = assertString(request.data?.token, "token", { min: 20, max: 120 });
    if (!/^[A-Za-z0-9_-]+$/.test(token)) {
      throw new HttpsError("invalid-argument", "Invalid photo link.");
    }

    const ref = db.collection(PHOTO_COLLECTION).doc(token);
    let files = [];

    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new HttpsError("not-found", "This photo link is not available.");
      }

      const data = snap.data() || {};
      const expiresAtMs = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : 0;
      if (expiresAtMs && expiresAtMs <= Date.now()) {
        throw new HttpsError("failed-precondition", "This photo link has expired.");
      }
      if (data.status !== "active") {
        throw new HttpsError("failed-precondition", "This photo link has already been viewed.");
      }

      files = data.files || [];
      tx.set(ref, {
        status: "viewing",
        viewedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });

    let photos = [];
    try {
      photos = await readPhotoReviewChunks(token);
      await deletePhotoChunks(token);
      await ref.set({
        status: "viewed",
        filesDeletedAt: FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      await ref.set({
        status: "error",
        error: error?.message || String(error),
        errorAt: FieldValue.serverTimestamp()
      }, { merge: true });
      throw new HttpsError("internal", "Photos could not be opened.");
    }

    return {
      ok: true,
      photos,
      message: "Photos were removed from storage after this view."
    };
  }
);

exports.cleanupExpiredOnlineBookingPhotos = onSchedule(
  {
    region: "us-central1",
    schedule: "every 1 hours",
    timeZone: "America/Edmonton"
  },
  async () => {
    const snap = await db.collection(PHOTO_COLLECTION)
      .where("expiresAt", "<=", admin.firestore.Timestamp.now())
      .limit(50)
      .get();

    await Promise.all(snap.docs.map(async docSnap => {
      const data = docSnap.data() || {};
      if (data.status === "active" || data.status === "viewing" || data.status === "error") {
        await deletePhotoChunks(docSnap.id);
        await docSnap.ref.set({
          status: "expired",
          filesDeletedAt: FieldValue.serverTimestamp(),
          expiredAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
    }));
  }
);

exports.getOnlineBookingAvailability = onCall(
  {
    region: "us-central1",
    maxInstances: 5
  },
  async (request) => {
    const input = request.data || {};
    const date = assertDate(input.date);
    const requestedGroups = getRequestedServiceGroups(input);

    const requestedDate = getLocalDate(date);
    if (Number.isNaN(requestedDate.getTime())) {
      throw new HttpsError("invalid-argument", "Invalid date.");
    }

    const [staffSnap, appointmentsSnap, offWorkSnap, weeklyOffSnap] = await Promise.all([
      db.collection("staff").get(),
      db.collection("appointments").where("date", "==", date).get(),
      db.collection("OffWork").where("date", "==", date).get(),
      db.collection("WeeklyOff").get()
    ]);

    const staffRecords = staffSnap.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    }));
    const appointments = appointmentsSnap.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    }));
    const offWorkRecords = offWorkSnap.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    }));
    const weeklyOffRecords = weeklyOffSnap.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    }));

    return getAvailabilityForDate({
      date,
      requestedGroups,
      appointments,
      staffRecords,
      offWorkRecords,
      weeklyOffRecords
    });
  }
);

exports.createStaffAuthUser = onCall(
  { region: "us-central1" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const callerUid = request.auth.uid;
    const callerSnap = await db.collection("users").doc(callerUid).get();

    if (!callerSnap.exists) {
      throw new HttpsError("permission-denied", "User profile not found.");
    }

    const callerData = callerSnap.data();

    if (callerData.role !== "manager") {
      throw new HttpsError("permission-denied", "Only manager can create staff auth users.");
    }

    const data = request.data || {};
    const email = String(data.email || "").trim().toLowerCase();
    const role = String(data.role || "staff").trim();
    const staffId = data.staffId ? String(data.staffId) : null;
    const staffName = String(data.staffName || "Team member").trim();

    if (!email) {
      throw new HttpsError("invalid-argument", "Email is required.");
    }

    let userRecord;
    let isNewUser = false;

    try {
      userRecord = await admin.auth().getUserByEmail(email);
    } catch (error) {
      if (error.code === "auth/user-not-found") {
        userRecord = await admin.auth().createUser({
          email: email,
          password: "Temp1234!"
        });
        isNewUser = true;
      } else {
        throw error;
      }
    }

    await db.collection("users").doc(userRecord.uid).set(
      {
        email: email,
        role: role,
        staffId: staffId
      },
      { merge: true }
    );

    if (isNewUser) {
 const telegramText =
  `Hello ${staffName}, welcome to Rose's Nails Calendar.\n\n` +
  `Your login is ready now.\n\n` +
  `Please use Forgot Password on the login screen.\n` +
  `If you do not see the email, please check your Spam/Junk folder.`;
      try {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: telegramText
          })
        });
      } catch (telegramError) {
        console.error("Telegram welcome message error:", telegramError);
      }
    }

    return {
      ok: true,
      uid: userRecord.uid,
      isNewUser: isNewUser
    };
  }
);
