const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted, onDocumentWritten } =
require("firebase-functions/v2/firestore");
const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");

const admin = require("firebase-admin");
const fetch = require("node-fetch");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { canMutateAnyAppointment } = require("./appointment-access");
const { shouldProcessStaffPush } = require("./push-notification");
const {
  buildSessionTokenHash,
  buildVerificationCodeHash,
  buildPhoneLookupVariants,
  getClientCancellationRecordState,
  getPhotoRetentionDeadlineMs,
  getVerificationRateDecision,
  isUpcomingAppointmentForClient,
  normalizeClientName,
  normalizePhoneDigits,
  secureHashesEqual
} = require("./booking-management");
const {
  SCHEDULE_SCHEMA_VERSION,
  appointmentUsesSchedule,
  buildScheduleSlots,
  cloneSlots,
  findScheduleOverlaps,
  getScheduleId,
  releaseAppointmentFromSlots,
  reserveAppointmentSlots
} = require("./appointment-schedule");
const {
  applyHistoryPreferences,
  getServiceFingerprint,
  normalizePhone,
  parseServiceIntent,
  stripPrivateAppointmentFields,
  summarizeClientHistory
} = require("./client-history-core");
const {
  APPOINTMENT_PRIVATE_COLLECTION,
  CLIENT_HISTORY_COLLECTION,
  CLIENT_PROFILE_COLLECTION,
  CLIENT_SCHEMA_VERSION,
  CLIENT_SUMMARY_VERSION,
  applyClientIdentityPlan,
  deleteClientAppointmentRecords,
  getCachedProfileSummary,
  invalidateClientProfileSummary,
  loadClientHistoryInTransaction,
  planClientIdentityInTransaction,
  readClientContext,
  readClientIdentity,
  readPhoneClient,
  writeClientAppointmentRecords
} = require("./client-history-store");
const {
  getBookingDurationDecision
} = require("./booking-duration");

admin.initializeApp();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const ANYONE_ID = "anyone";
const APPOINTMENT_SCHEDULE_COLLECTION = "appointmentSchedules";
const SLOT_COUNT = 49;
const ANYONE_DISPLAY_DURATION = 1;
const ANYONE_REQUIRED_DURATION = 4;
const MAX_PHOTO_LINKS = 2;
const MAX_REQUEST_TEXT = 1200;
const BOOKING_DURATION = 4;
const BOOKING_LATEST_START_SLOT = 42; // 6:30 PM
const BOOKING_MIN_LEAD_MINUTES = 60;
const SALON_TIME_ZONE = "America/Edmonton";
const BOOKING_SERVICE_GROUPS = ["manicure", "pedicure", "acrylics", "brows", "waxing", "lashes"];
const DEFAULT_BOOKING_SERVICE_GROUPS = ["manicure", "pedicure"];
const MAX_PHOTO_UPLOADS = 3;
const MAX_PHOTO_BYTES = 1250000;
const PHOTO_TTL_MS = 24 * 60 * 60 * 1000;
const STAFF_NOTIFICATION_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const PUSH_DEVICE_TTL_MS = 120 * 24 * 60 * 60 * 1000;
const PHOTO_COLLECTION = "onlineBookingPhotos";
const PHOTO_STORAGE_PREFIX = "online-booking-photos";
const PHOTO_REVIEW_BASE_URL = "https://rosesnails-calendar.web.app/booking-photo";
const PHOTO_BUCKET_NAME = "rosesnails-calendar.firebasestorage.app";
const EMAIL_QUEUE_COLLECTION = "EmailQueue";
const SMS_QUEUE_COLLECTION = "SmsQueue";
const BOOKING_VERIFICATION_COLLECTION = "onlineBookingVerificationChallenges";
const BOOKING_VERIFICATION_RATE_COLLECTION = "onlineBookingVerificationRateLimits";
const BOOKING_VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const BOOKING_VERIFICATION_SESSION_TTL_MS = 20 * 60 * 1000;
const BOOKING_VERIFICATION_CLEANUP_TTL_MS = 24 * 60 * 60 * 1000;
const BOOKING_VERIFICATION_MAX_ATTEMPTS = 5;
const ONLINE_BOOKING_CLIENT_CANCEL_COMMENT = "Client cancelled appointment through online booking.";
const SALON_PHONE_E164 = "+17804066767";
const SALON_PHONE_DISPLAY = "+1 780-406-6767";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15876060462";
const BOOKING_EMAIL_CONTACT_COLLECTION = "onlineBookingEmailContacts";
const BOOKING_EMAIL_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const PRIVACY_CONSENT_VERSION = "privacy-consent-v3-2026-09-06";
const EMAIL_DEFAULT_FROM_NAME = "Rose's Nails";
const EMAIL_DEFAULT_FROM_EMAIL = "booking@rosesnailslondonderry.ca";
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || "gmailTest";
const EMAIL_TEST_GMAIL_USER = "rosesnails13721@gmail.com";
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || EMAIL_DEFAULT_FROM_NAME;
const EMAIL_FROM_EMAIL = process.env.EMAIL_FROM_EMAIL || (EMAIL_PROVIDER === "gmailTest" ? EMAIL_TEST_GMAIL_USER : EMAIL_DEFAULT_FROM_EMAIL);
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");
const CLIENT_LOOKUP_PEPPER = defineSecret("CLIENT_LOOKUP_PEPPER");

function getClientLookupPepper() {
  const value = String(CLIENT_LOOKUP_PEPPER.value() || "").trim();
  if (!value) throw new Error("CLIENT_LOOKUP_PEPPER is not configured.");
  return value;
}

/* === ÐÐÐ¡Ð¢Ð ÐžÐ™ÐšÐ˜ TELEGRAM === */
// Operational pause: keep the Telegram integration intact while preventing
// queue writes and outbound messages. Set to false to resume Telegram.
const TELEGRAM_NOTIFICATIONS_PAUSED = true;
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
function normalizeOptionalEmail(value) {
const email = String(value || "").trim().toLowerCase();
if (!email) return "";
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  throw new HttpsError("invalid-argument", "Invalid email.");
}
return email;
}
function escapeHtml(value) {
return String(value || "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");
}
function plainLines(lines) {
return lines.filter(Boolean).join("\n");
}
function buildBookingEmailContent(eventType, data) {
const client = data.client || "there";
const dateLine = [data.bookingDate, data.bookingTime].filter(Boolean).join(" at ");
const staffLine = data.staffName ? `Technician: ${data.staffName}` : "";
const serviceLine = data.service ? `Service: ${data.service}` : "";
const contactUsLine = `please contact us at ${SALON_PHONE_DISPLAY}`;
const salonPhoneHtml = `<a href="tel:${SALON_PHONE_E164}">${escapeHtml(SALON_PHONE_DISPLAY)}</a>`;

if (eventType === "booking_confirmed") {
  const text = plainLines([
    `Hello ${client},`,
    "",
    `Your appointment is confirmed${dateLine ? ` for ${dateLine}` : ""}.`,
    staffLine,
    serviceLine,
    "",
    "See you soon.",
    "",
    `If anything changes, please let us know at ${SALON_PHONE_DISPLAY}.`
  ]);
  return {
    subject: "Rose's Nails appointment confirmed",
    text,
    html: `<p>Hello ${escapeHtml(client)},</p><p>Your appointment is confirmed${dateLine ? ` for ${escapeHtml(dateLine)}` : ""}.</p>${staffLine ? `<p>${escapeHtml(staffLine)}</p>` : ""}${serviceLine ? `<p>${escapeHtml(serviceLine)}</p>` : ""}<p>See you soon.</p><p>If anything changes, please let us know at ${salonPhoneHtml}.</p>`
  };
}

if (eventType === "booking_unavailable") {
  const text = plainLines([
    `Hello ${client},`,
    "",
    "The time you selected is no longer available or does not have enough time for the requested service.",
    "Our team will contact you to offer another time, day, or technician for your visit.",
    `If you do not hear from us soon, ${contactUsLine}.`
  ]);
  return {
    subject: "Rose's Nails booking request update",
    text,
    html: `<p>Hello ${escapeHtml(client)},</p><p>The time you selected is no longer available or does not have enough time for the requested service.</p><p>Our team will contact you to offer another time, day, or technician for your visit.</p><p>If you do not hear from us soon, please contact us at ${salonPhoneHtml}.</p>`
  };
}

const text = plainLines([
  `Hello ${client},`,
  "",
  `We received your booking request${dateLine ? ` for ${dateLine}` : ""}.`,
  staffLine,
  serviceLine,
  "This appointment is not confirmed yet.",
  "Your request is under review. After we review it, you will receive a confirmation or an update by text message, phone, or email if you added one.",
  `If you do not hear from us soon, ${contactUsLine}.`
]);
return {
  subject: "Rose's Nails booking request received",
  text,
  html: `<p>Hello ${escapeHtml(client)},</p><p>We received your booking request${dateLine ? ` for ${escapeHtml(dateLine)}` : ""}.</p>${staffLine ? `<p>${escapeHtml(staffLine)}</p>` : ""}${serviceLine ? `<p>${escapeHtml(serviceLine)}</p>` : ""}<p>This appointment is not confirmed yet.</p><p>Your request is under review. After we review it, you will receive a confirmation or an update by text message, phone, or email if you added one.</p><p>If you do not hear from us soon, please contact us at ${salonPhoneHtml}.</p>`
};
}
function buildBookingEmailQueueDoc({ eventType, appointmentId, appointmentData, staffRecords, email }) {
const staffName = getStaffName(staffRecords, appointmentData.staffId);
const service = appointmentData.note || "";
const content = buildBookingEmailContent(eventType, {
  client: appointmentData.client,
  bookingDate: appointmentData.date,
  bookingTime: slotToTime(appointmentData.start),
  staffName,
  service
});
return {
  status: "pending",
  to: email,
  fromName: EMAIL_FROM_NAME,
  fromEmail: EMAIL_FROM_EMAIL,
  subject: content.subject,
  text: content.text,
  html: content.html,
  eventType,
  entityType: "appointment",
  entityId: appointmentId,
  client: appointmentData.client,
  email,
  bookingDate: appointmentData.date,
  bookingTime: slotToTime(appointmentData.start),
  staffId: appointmentData.staffId,
  staffName,
  service,
  createdAt: FieldValue.serverTimestamp(),
  source: "onlineBooking"
};
}
function buildBookingEmailContactDoc({ email, appointmentId, requestId }) {
return {
  email,
  appointmentId,
  requestId,
  status: "active",
  createdAt: FieldValue.serverTimestamp(),
  expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + BOOKING_EMAIL_TTL_MS)),
  purpose: "appointment_email_notifications_only"
};
}

function getBookingStatusEmailEvent(status) {
if (status === "confirmed") return "booking_confirmed";
if (status === "declined") return "booking_unavailable";
return null;
}

function getBookingStatusSmsEvent(status) {
if (status === "confirmed") return "booking_confirmed";
if (status === "declined") return "booking_unavailable";
return null;
}

function hasOnlineBookingDeclineHistory(data) {
  if (!data) return false;
  if (data.status === "declined") return true;
  if (data.declinedAt) return true;
  const comment = String(data.cancelComment || "").toLowerCase();
  return data.canceled === true && comment.includes("online booking request declined");
}

function normalizePhoneToE164(value) {
const digits = String(value || "").replace(/\D/g, "");
if (!digits) return "";
if (digits.length === 10) return `+1${digits}`;
if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
return String(value || "").trim().startsWith("+") ? `+${digits}` : "";
}

function getPhoneLast4(value) {
const digits = String(value || "").replace(/\D/g, "");
return digits.slice(-4) || "unknown";
}

function buildBookingSmsContent(eventType, data) {
const dateLine = [data.bookingDate, data.bookingTime].filter(Boolean).join(" at ");
if (eventType === "booking_confirmed") {
  const staffLine = data.staffName ? ` with ${data.staffName}` : "";
  return `Your appointment at Rose's Nails is confirmed${dateLine ? ` for ${dateLine}` : ""}${staffLine}. See you soon!`;
}
return "Your online booking request at Rose's Nails cannot be confirmed for the selected time. We will contact you soon to find a better option.";
}

function buildBookingSmsQueueDoc({ eventType, appointmentId, appointmentData, staffRecords }) {
const staffName = getStaffName(staffRecords, appointmentData.staffId);
const to = normalizePhoneToE164(appointmentData.phone);
const body = buildBookingSmsContent(eventType, {
  bookingDate: formatDate(appointmentData.date),
  bookingTime: slotToTime(appointmentData.start),
  staffName
});
return {
  status: to ? "pending" : "skipped",
  to,
  from: TWILIO_FROM_NUMBER,
  body,
  eventType,
  entityType: "appointment",
  entityId: appointmentId,
  client: appointmentData.client || null,
  phoneLast4: getPhoneLast4(appointmentData.phone),
  bookingDate: appointmentData.date,
  bookingTime: slotToTime(appointmentData.start),
  staffId: appointmentData.staffId,
  staffName,
  createdAt: FieldValue.serverTimestamp(),
  source: "onlineBooking"
};
}

async function sendSmsViaTwilio(smsDoc) {
const accountSid = TWILIO_ACCOUNT_SID.value();
const authToken = TWILIO_AUTH_TOKEN.value();
if (!accountSid || !authToken || !TWILIO_FROM_NUMBER) {
  return { skipped: true, reason: "twilio_not_configured" };
}

const body = new URLSearchParams({
  To: smsDoc.to,
  From: TWILIO_FROM_NUMBER,
  Body: smsDoc.body
});
const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/x-www-form-urlencoded"
  },
  body
});
const responseText = await response.text();
let parsed = {};
try {
  parsed = JSON.parse(responseText);
} catch (error) {
  parsed = { raw: responseText };
}
if (!response.ok) {
  throw new Error(`Twilio SMS error ${response.status}: ${parsed.message || responseText}`);
}
return { providerMessageId: parsed.sid || null, providerStatus: parsed.status || null };
}

function getConfiguredEmailFrom() {
return {
  name: process.env.EMAIL_FROM_NAME || EMAIL_FROM_NAME,
  email: process.env.EMAIL_FROM_EMAIL || EMAIL_FROM_EMAIL
};
}
async function sendEmailViaGmailTest(emailDoc) {
const password = GMAIL_APP_PASSWORD.value();
if (!password) {
  return { skipped: true, reason: "gmail_not_configured" };
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: EMAIL_TEST_GMAIL_USER,
    pass: password
  }
});

const result = await transporter.sendMail({
  from: `${EMAIL_DEFAULT_FROM_NAME} <${EMAIL_TEST_GMAIL_USER}>`,
  to: emailDoc.to,
  subject: emailDoc.subject,
  text: emailDoc.text,
  html: emailDoc.html || undefined
});

return { providerMessageId: result.messageId || null };
}

async function sendEmailViaResend(emailDoc) {
const apiKey = process.env.RESEND_API_KEY;
const from = getConfiguredEmailFrom();
if (!apiKey || !from.email) {
  return { skipped: true, reason: "not_configured" };
}

// Production email sending should use the salon domain rosesnailslondonderry.ca
// after DNS verification in Resend: SPF, DKIM, and DMARC.
const response = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    from: `${from.name} <${from.email}>`,
    to: [emailDoc.to],
    subject: emailDoc.subject,
    text: emailDoc.text,
    html: emailDoc.html || undefined
  })
});
const body = await response.text();
if (!response.ok) {
  throw new Error(`Resend error ${response.status}: ${body}`);
}
let parsed = {};
try {
  parsed = JSON.parse(body);
} catch (error) {
  parsed = {};
}
return { providerMessageId: parsed.id || null };
}

async function sendEmailViaProvider(emailDoc) {
if (EMAIL_PROVIDER === "gmailTest") {
  return sendEmailViaGmailTest(emailDoc);
}
if (EMAIL_PROVIDER === "resend") {
  return sendEmailViaResend(emailDoc);
}
return { skipped: true, reason: `unsupported_provider_${EMAIL_PROVIDER}` };
}
async function sendBookingEmail(emailDoc) {
return sendEmailViaProvider(emailDoc);
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
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
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

function getSalonNowParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SALON_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function getMinimumBookableSlot(dateStr, now = new Date()) {
  const current = getSalonNowParts(now);
  if (dateStr < current.date) return Number.POSITIVE_INFINITY;
  if (dateStr > current.date) return 0;

  const earliestMinutes = current.minutes + BOOKING_MIN_LEAD_MINUTES;
  const minutesFromCalendarStart = earliestMinutes - 8 * 60;
  return Math.max(0, Math.ceil(minutesFromCalendarStart / 15));
}

function isBookableOnlineStart({ date, start, duration = BOOKING_DURATION, now = new Date() }) {
  const hours = getSalonBookingHours(date);
  const minStart = Math.max(hours.start, getMinimumBookableSlot(date, now));
  return start >= minStart && start <= BOOKING_LATEST_START_SLOT && start + duration <= hours.end;
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
  const serviceIntent = parseServiceIntent({ serviceDetails: normalized });

  if (/brow|eyebrow|tint/.test(normalized)) groups.push("brows");
  if (/lash|eyelash/.test(normalized)) groups.push("lashes");
  if (/wax|waxing/.test(normalized) && !/brow|eyebrow/.test(normalized)) groups.push("waxing");
  if (/acrylic|акрил/.test(normalized)) groups.push("acrylics");
  if (serviceIntent.feet) groups.push("pedicure");
  if (serviceIntent.hands && !/^acrylic/.test(serviceIntent.hands.key || "")) groups.push("manicure");
  if (!serviceIntent.hands && /nail|gel|shellac|french|design/.test(normalized)) groups.push("manicure");

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

function isActiveStaffRecord(staffRecord) {
  return staffRecord?.active !== false;
}

function getActiveStaffRecords(staffRecords) {
  return staffRecords.filter(isActiveStaffRecord);
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

function assertAppointmentStart(value) {
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < -1 || slot >= SLOT_COUNT) {
    throw new HttpsError("invalid-argument", "Invalid appointment time.");
  }
  return slot;
}

function assertAppointmentDuration(value, staffId) {
  if (staffId === ANYONE_ID) return ANYONE_DISPLAY_DURATION;
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < 1 || duration > 48) {
    throw new HttpsError("invalid-argument", "Invalid appointment duration.");
  }
  return duration;
}

function assertAppointmentToken(value, field, { min = 12, max = 100 } = {}) {
  const token = assertString(value, field, { min, max });
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new HttpsError("invalid-argument", `Invalid ${field}.`);
  }
  return token;
}

function normalizeOptionalText(value, field, max) {
  if (value === null || value === undefined) return null;
  const text = assertString(value, field, { max });
  return text || null;
}

function sanitizeAppointmentForm(input, actor) {
  const raw = input && typeof input === "object" ? input : {};
  const staffId = assertString(raw.staffId, "staffId", { min: 1, max: 100 });
  const submittedPhone = normalizeOptionalText(raw.phone, "phone", 40);
  const phone = actor.role === "manager" ? submittedPhone : null;
  const groupTagInput = normalizeOptionalText(raw.groupTag, "groupTag", 40);
  const groupTag = actor.role === "manager" && groupTagInput && /^[A-Za-z0-9_-]+$/.test(groupTagInput)
    ? groupTagInput
    : null;

  return {
    date: assertDate(raw.date),
    staffId,
    phone,
    phoneLookup: normalizePhoneDigits(phone) || null,
    start: assertAppointmentStart(raw.start),
    duration: assertAppointmentDuration(raw.duration, staffId),
    client: assertString(raw.client, "client", { max: 120 }),
    note: assertString(raw.note, "note", { max: 2500 }),
    groupTag,
    noShow: raw.noShow === true,
    canceled: raw.canceled === true,
    cancelComment: raw.canceled === true
      ? normalizeOptionalText(raw.cancelComment, "cancelComment", 500)
      : null
  };
}

function isPendingOnlineRequest(appointment) {
  return Boolean(
    appointment &&
    appointment.type === "online_booking_request" &&
    appointment.status === "request" &&
    appointment.canceled !== true
  );
}

function isDeclinedOnlineRequest(appointment) {
  return Boolean(
    appointment &&
    appointment.source === "online_booking" &&
    appointment.status === "declined"
  );
}

function getAppointmentSaveAction(before, after) {
  if (!before) return "create";
  if (before.canceled !== true && after.canceled === true) return "cancel";
  if (before.canceled === true && after.canceled !== true) return "cancel_removed";
  if (before.noShow !== true && after.noShow === true) return "no_show";
  if (before.noShow === true && after.noShow !== true) return "no_show_removed";
  if (before.date !== after.date) return "move";
  return "edit";
}

function hasSameScheduledPlacement(before, after) {
  return Boolean(
    appointmentUsesSchedule(before, ANYONE_ID) &&
    appointmentUsesSchedule(after, ANYONE_ID) &&
    before.date === after.date &&
    before.staffId === after.staffId &&
    Number(before.start) === Number(after.start) &&
    Number(before.duration) === Number(after.duration)
  );
}

function getAppointmentScheduleDescriptor(appointment) {
  if (!appointmentUsesSchedule(appointment, ANYONE_ID)) return null;
  const date = appointment.date;
  const staffId = appointment.staffId;
  return {
    key: getScheduleId(date, staffId),
    date,
    staffId
  };
}

async function loadAppointmentScheduleStates(tx, appointments) {
  const descriptors = new Map();
  appointments.forEach(appointment => {
    const descriptor = getAppointmentScheduleDescriptor(appointment);
    if (descriptor) descriptors.set(descriptor.key, descriptor);
  });

  const states = new Map();
  for (const descriptor of descriptors.values()) {
    const ref = db.collection(APPOINTMENT_SCHEDULE_COLLECTION).doc(descriptor.key);
    const snap = await tx.get(ref);
    states.set(descriptor.key, {
      ...descriptor,
      ref,
      exists: snap.exists,
      slots: snap.exists ? cloneSlots(snap.data()?.slots) : null,
      changed: false
    });
  }

  const appointmentsByDate = new Map();
  for (const state of states.values()) {
    if (state.exists || appointmentsByDate.has(state.date)) continue;
    const snap = await tx.get(db.collection("appointments").where("date", "==", state.date));
    appointmentsByDate.set(state.date, snap.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    })));
  }

  for (const state of states.values()) {
    if (state.exists) continue;
    state.slots = buildScheduleSlots(appointmentsByDate.get(state.date) || [], {
      date: state.date,
      staffId: state.staffId,
      anyoneId: ANYONE_ID
    });
  }

  return states;
}

function updateAppointmentScheduleStates(states, before, after, appointmentId) {
  const beforeDescriptor = getAppointmentScheduleDescriptor(before);
  const afterDescriptor = getAppointmentScheduleDescriptor(after);
  const samePlacement = hasSameScheduledPlacement(before, after);

  if (beforeDescriptor && !samePlacement) {
    const state = states.get(beforeDescriptor.key);
    state.slots = releaseAppointmentFromSlots(state.slots, before, appointmentId);
    state.changed = true;
  }

  if (afterDescriptor && !samePlacement) {
    const state = states.get(afterDescriptor.key);
    try {
      state.slots = reserveAppointmentSlots(state.slots, after, appointmentId);
      state.changed = true;
    } catch (error) {
      if (error?.code === "appointment-conflict") {
        throw new HttpsError(
          "already-exists",
          "This time is already occupied by another appointment.",
          {
            reason: "appointment-conflict",
            conflictingAppointmentIds: error.conflictingAppointmentIds || []
          }
        );
      }
      throw error;
    }
  }
}

function writeAppointmentScheduleStates(tx, states) {
  for (const state of states.values()) {
    if (state.exists && !state.changed) continue;
    tx.set(state.ref, {
      schemaVersion: SCHEDULE_SCHEMA_VERSION,
      date: state.date,
      staffId: state.staffId,
      slots: state.slots,
      updatedAt: FieldValue.serverTimestamp()
    });
  }
}

async function getAuthorizedCalendarActor(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in.");
  }

  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  if (!userSnap.exists) {
    throw new HttpsError("permission-denied", "User profile not found.");
  }

  const profile = userSnap.data() || {};
  const role = String(profile.role || "").trim();
  if (!canMutateAnyAppointment(role)) {
    throw new HttpsError("permission-denied", "This user cannot change appointments.");
  }

  const staffId = profile.staffId ? String(profile.staffId) : null;
  let staffName = "";
  if (staffId) {
    const staffSnap = await db.collection("staff").doc(staffId).get();
    staffName = staffSnap.exists ? String(staffSnap.data()?.name || "").trim() : "";
  }

  const label = role === "reception"
    ? "Reception"
    : (staffName || (role === "manager" ? "Manager" : "Staff"));

  return { uid: request.auth.uid, role, staffId, label };
}

async function requireManagerActor(request) {
  const actor = await getAuthorizedCalendarActor(request);
  if (actor.role !== "manager") {
    throw new HttpsError("permission-denied", "Manager access is required.");
  }
  return actor;
}

function getAnyoneRemainingCapacity({
  date,
  start,
  appointments,
  staffRecords,
  offWorkRecords,
  weeklyOffRecords,
  requestedGroups = DEFAULT_BOOKING_SERVICE_GROUPS,
  durationInput = {},
  clientSummary = null
}) {
  const realStaff = staffRecords
    .filter(s => s.id && s.id !== ANYONE_ID)
    .filter(s => s.bookingEnabled !== false)
    .filter(s => s.availableForAnyone !== false)
    .filter(s => staffCanDoServiceGroups(s, requestedGroups))
    .map(s => ({
      ...s,
      requestedDuration: getBookingDurationDecision({
        ...durationInput,
        requestedGroups
      }, s, clientSummary).duration
    }));
  const availableStaffCount = realStaff.filter(s => realStaffAvailable({
    staffId: s.id,
    date,
    start,
    end: start + s.requestedDuration,
    appointments,
    offWorkRecords,
    weeklyOffRecords
  }) && isBookableOnlineStart({
    date,
    start,
    duration: s.requestedDuration
  })).length;

  const existingAnyoneCount = appointments.filter(a => {
    if (!isActiveAppointment(a)) return false;
    if (a.staffId !== ANYONE_ID) return false;
    if (a.date !== date) return false;
    const anyoneStart = Number(a.start);
    return rangesOverlap(
      start,
      start + ANYONE_REQUIRED_DURATION,
      anyoneStart,
      anyoneStart + ANYONE_REQUIRED_DURATION
    );
  }).length;

  return availableStaffCount - existingAnyoneCount;
}

function getAvailabilityForDate({
  date,
  requestedGroups,
  durationInput = {},
  appointments,
  staffRecords,
  offWorkRecords,
  weeklyOffRecords,
  clientSummary = null
}) {
  const hours = getSalonBookingHours(date);
  const minBookableSlot = Math.max(hours.start, getMinimumBookableSlot(date));
  const maxBookableStartSlot = Math.min(BOOKING_LATEST_START_SLOT, hours.end - 1);
  const realStaff = staffRecords
    .filter(s => s.id && s.id !== ANYONE_ID)
    .filter(s => s.bookingEnabled !== false)
    .map(s => {
      const durationDecision = getBookingDurationDecision({
        ...durationInput,
        requestedGroups
      }, s, clientSummary);
      return {
        id: s.id,
        name: s.name || "Staff",
        availableForAnyone: s.availableForAnyone !== false,
        serviceGroups: getStaffServiceGroups(s),
        canDoRequestedServices: staffCanDoServiceGroups(s, requestedGroups),
        requestedDuration: durationDecision.duration
      };
    });

  const times = [];

  for (let slot = minBookableSlot; slot <= maxBookableStartSlot; slot++) {
    const availableStaff = realStaff
      .filter(s => s.canDoRequestedServices)
      .filter(s => isBookableOnlineStart({ date, start: slot, duration: s.requestedDuration }))
      .filter(s => realStaffAvailable({
        staffId: s.id,
        date,
        start: slot,
        end: slot + s.requestedDuration,
        appointments,
        offWorkRecords,
        weeklyOffRecords
      }))
      .map(s => s.id);

    const anyoneRemainingCapacity = isBookableOnlineStart({ date, start: slot, duration: ANYONE_REQUIRED_DURATION })
      ? getAnyoneRemainingCapacity({
          date,
          start: slot,
          appointments,
          staffRecords,
          offWorkRecords,
          weeklyOffRecords,
          requestedGroups,
          durationInput,
          clientSummary
        })
      : 0;

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
    staff: realStaff.map(member => ({
      id: member.id,
      name: member.name,
      serviceGroups: member.serviceGroups
    })),
    times
  };
}

function buildRequestNote({ selectedServices, serviceDetails }) {
  return String(serviceDetails || "").trim().slice(0, MAX_REQUEST_TEXT);
}

function getStaffName(staffRecords, staffId) {
  if (staffId === ANYONE_ID) return "Anyone";
  return staffRecords.find(s => s.id === staffId)?.name || "Staff";
}


function stripNotificationHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function buildStaffNotificationDoc({
  message,
  eventType,
  entityType,
  entityId,
  staffId,
  staffName,
  photoReviewUrl = "",
  source = "calendar",
  messageGroupId = ""
}) {
  const body = stripNotificationHtml(message);
  const priority = eventType === "online_request_created" ||
    eventType === "new_app" ||
    eventType === "moved" ||
    eventType === "canceled" ||
    eventType === "deleted_app"
      ? "key"
      : "secondary";

  const titleMap = {
    online_request_created: "Online booking request",
    online_request_confirmed: "Online request confirmed",
    online_request_declined: "Online request declined",
    new_app: "New appointment",
    moved: "Appointment moved",
    updated_app: "Appointment updated",
    canceled: "Appointment canceled",
    deleted_app: "Appointment deleted",
    no_show: "No-show"
  };

  return {
    recipientStaffId: staffId || "",
    recipientStaffName: staffName || "",
    visibleToManager: true,
    title: titleMap[eventType] || "Calendar message",
    body,
    eventType,
    entityType,
    entityId: entityId || "",
    staffId: staffId || "",
    staffName: staffName || "",
    priority,
    pushEligible: priority === "key",
    photoReviewUrl,
    readBy: {},
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + STAFF_NOTIFICATION_TTL_MS)),
    source,
    messageGroupId
  };
}

function buildCanonicalStaffMessageDoc({
  message,
  eventType,
  entityType,
  entityId,
  staffId,
  staffName,
  staffRecords,
  photoReviewUrl = "",
  source = "calendar",
  messageGroupId = ""
}) {
  const legacy = buildStaffNotificationDoc({
    message,
    eventType,
    entityType,
    entityId,
    staffId,
    staffName,
    photoReviewUrl,
    source,
    messageGroupId
  });
  const audienceStaffIds = staffRecords
    .map(staff => staff.id)
    .filter(id => id && id !== ANYONE_ID);
  return {
    ...legacy,
    recipientStaffId: "",
    recipientStaffName: "",
    visibleToAllStaff: true,
    audienceVersion: 2,
    audienceStaffIds,
    importantStaffIds: staffId && staffId !== ANYONE_ID ? [staffId] : [],
    managerPriority: "key",
    staffDefaultPriority: "secondary",
    pushEligible: true,
    notificationLink: "https://rosesnails-calendar.web.app"
  };
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
if (TELEGRAM_NOTIFICATIONS_PAUSED) return;
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

function readTwilioParam(req, name) {
if (req.body && typeof req.body === "object" && req.body[name] !== undefined) {
  return String(req.body[name] || "");
}
const raw = req.rawBody ? req.rawBody.toString("utf8") : "";
return new URLSearchParams(raw).get(name) || "";
}

function readTwilioParams(req) {
const params = {};
if (req.body && typeof req.body === "object") {
  Object.keys(req.body).forEach(key => {
    params[key] = String(req.body[key] || "");
  });
  return params;
}
const raw = req.rawBody ? req.rawBody.toString("utf8") : "";
for (const [key, value] of new URLSearchParams(raw).entries()) {
  params[key] = value;
}
return params;
}

function validateTwilioSignature(req) {
const authToken = TWILIO_AUTH_TOKEN.value();
const signature = req.get("x-twilio-signature") || "";
if (!authToken || !signature) return false;
const params = readTwilioParams(req);
const url = `https://${req.get("host")}${req.originalUrl}`;
const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
const expected = crypto.createHmac("sha1", authToken).update(data).digest("base64");
if (signature.length !== expected.length) return false;
return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

function buildIncomingSmsTelegramMessage({ from, body }) {
const last4 = getPhoneLast4(from);
const cleanBody = String(body || "").trim() || "(empty message)";
return plainLines([
  "Incoming SMS reply from online booking page",
  "",
  `From: client ending ${last4}`,
  "",
  "Text message:",
  escapeHtml(cleanBody)
]);
}

/* === TELEGRAM QUEUE TRIGGER (GEN 2) === */

exports.telegramQueueCreated = onDocumentCreated(
  "TelegramQueue/{id}",
  async (event) => {
    if (TELEGRAM_NOTIFICATIONS_PAUSED) return;

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


function getPhotoBucket() {
  return admin.storage().bucket(PHOTO_BUCKET_NAME);
}

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
      buffer,
      size: buffer.length
    };
  });
}

async function storeOnlineBookingPhotos({ photos, appointmentId, requestId }) {
  if (!photos.length) return null;

  const token = crypto.randomBytes(24).toString("base64url");
  const bucket = getPhotoBucket();
  const files = [];

  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index];
    const extension = photo.contentType === "image/png" ? "png" : photo.contentType === "image/webp" ? "webp" : "jpg";
    const storagePath = `${PHOTO_STORAGE_PREFIX}/${token}/${index + 1}.${extension}`;
    await bucket.file(storagePath).save(photo.buffer, {
      resumable: false,
      metadata: {
        contentType: photo.contentType,
        cacheControl: "private, no-store, max-age=0",
        metadata: {
          originalName: photo.name,
          appointmentId,
          requestId
        }
      }
    });
    files.push({ path: storagePath, name: photo.name, contentType: photo.contentType, size: photo.size });
  }

  const reviewUrl = getPhotoReviewUrl(token);
  await db.collection(PHOTO_COLLECTION).doc(token).set({
    token,
    appointmentId,
    requestId,
    status: "active",
    files,
    reviewUrl,
    createdAt: FieldValue.serverTimestamp(),
    retentionState: "pending_appointment_decision",
    retentionPolicyVersion: 3,
    expiresAt: null
  });

  return {
    token,
    url: reviewUrl,
    refs: files.map(file => ({ name: file.name, path: file.path, contentType: file.contentType, size: file.size }))
  };
}

async function deletePhotoFiles(files) {
  const bucket = getPhotoBucket();
  await Promise.all((files || []).map(async file => {
    if (!file?.path) return;
    try {
      await bucket.file(file.path).delete({ ignoreNotFound: true });
    } catch (error) {
      console.error("Photo delete error:", file.path, error);
    }
  }));
}

async function closePhotoReview(token, status) {
  if (!token) return;
  const ref = db.collection(PHOTO_COLLECTION).doc(token);
  const snap = await ref.get();
  if (!snap.exists) return;
  const data = snap.data() || {};
  await deletePhotoFiles(data.files || []);
  await ref.set({
    status,
    closedAt: FieldValue.serverTimestamp(),
    filesDeletedAt: FieldValue.serverTimestamp()
  }, { merge: true });
}

async function readPhotoReviewFiles(files) {
  const bucket = getPhotoBucket();
  const photos = [];
  for (const file of files || []) {
    const [buffer] = await bucket.file(file.path).download();
    const contentType = file.contentType || "image/jpeg";
    photos.push({
      name: file.name || "photo.jpg",
      contentType,
      dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`
    });
  }
  return photos;
}
exports.mutateAppointment = onCall(
  {
    region: "us-central1",
    maxInstances: 10,
    secrets: [CLIENT_LOOKUP_PEPPER]
  },
  async (request) => {
    const actor = await getAuthorizedCalendarActor(request);
    const input = request.data || {};
    const mode = assertString(input.mode, "mode", { min: 3, max: 20 });
    if (!["create", "update", "confirm", "decline", "delete"].includes(mode)) {
      throw new HttpsError("invalid-argument", "Invalid appointment operation.");
    }

    const appointmentId = assertAppointmentToken(input.appointmentId, "appointmentId", { min: 12, max: 100 });
    const mutationId = assertAppointmentToken(input.mutationId, "mutationId", { min: 12, max: 100 });
    const form = mode === "delete" ? null : sanitizeAppointmentForm(input.appointment, actor);
    const expectedRevision = mode === "create" ? null : Number(input.expectedRevision);
    if (mode !== "create" && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
      throw new HttpsError("invalid-argument", "Invalid appointment revision.");
    }

    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const privateAppointmentRef = db.collection(APPOINTMENT_PRIVATE_COLLECTION).doc(appointmentId);

    return db.runTransaction(async tx => {
      const appointmentSnap = await tx.get(appointmentRef);
      const before = appointmentSnap.exists ? appointmentSnap.data() : null;

      if (
        before &&
        before.lastMutationId === mutationId &&
        before.lastMutationMode === mode
      ) {
        return {
          ok: true,
          duplicate: true,
          appointmentId,
          revision: Number(before.revision) || 0,
          lastAction: before.lastAction || null,
          hasPrivateContact: before.hasPrivateContact === true
        };
      }

      if (mode === "create" && before) {
        throw new HttpsError("already-exists", "This appointment already exists.");
      }
      if (mode !== "create" && !before) {
        throw new HttpsError("not-found", "Appointment no longer exists.");
      }

      const currentRevision = Number(before?.revision) || 0;
      if (mode !== "create" && expectedRevision !== currentRevision) {
        throw new HttpsError(
          "aborted",
          "Appointment changed in another calendar. Reopen it and try again.",
          { reason: "stale-revision", currentRevision }
        );
      }

      const privateAppointmentSnap = before?.hasPrivateContact === true
        ? await tx.get(privateAppointmentRef)
        : null;
      const beforePrivate = privateAppointmentSnap?.exists
        ? privateAppointmentSnap.data() || {}
        : null;

      let after = null;
      let lastAction = null;

      if (mode === "create") {
        after = {
          ...form,
          type: null,
          source: null,
          status: null,
          confirmedAt: null,
          confirmedBy: null,
          declinedAt: null,
          declinedBy: null,
          createdAt: FieldValue.serverTimestamp(),
          createdMutationId: mutationId
        };
        lastAction = "create";
      } else if (mode === "update") {
        if (isPendingOnlineRequest(before)) {
          throw new HttpsError("failed-precondition", "Use Confirm or Decline for this online request.");
        }

        const safeForm = actor.role === "manager"
          ? form
          : {
              ...form,
              groupTag: before.groupTag || null,
              phone: before.phone || null,
              phoneLookup: before.phoneLookup || null
            };
        after = { ...before, ...safeForm };

        if (isDeclinedOnlineRequest(before)) {
          after.type = "appointment";
          after.source = "online_booking";
          if (after.canceled === true) {
            after.status = "declined";
            after.cancelComment = after.cancelComment || "Online booking request declined";
          } else {
            after.status = "restored_after_decline";
            after.cancelComment = null;
          }
        }
        lastAction = getAppointmentSaveAction(before, after);
      } else if (mode === "confirm") {
        if (!isPendingOnlineRequest(before)) {
          throw new HttpsError("failed-precondition", "This online request is no longer pending.");
        }
        const safeForm = actor.role === "manager"
          ? form
          : {
              ...form,
              groupTag: before.groupTag || null,
              phone: before.phone || null,
              phoneLookup: before.phoneLookup || null
            };
        after = {
          ...before,
          ...safeForm,
          noShow: false,
          canceled: false,
          cancelComment: null,
          type: "appointment",
          source: "online_booking",
          status: "confirmed",
          confirmedAt: FieldValue.serverTimestamp(),
          confirmedBy: actor.label,
          declinedAt: null,
          declinedBy: null
        };
        lastAction = "online_request_confirmed";
      } else if (mode === "decline") {
        if (!isPendingOnlineRequest(before)) {
          throw new HttpsError("failed-precondition", "This online request is no longer pending.");
        }
        const safeForm = actor.role === "manager"
          ? form
          : {
              ...form,
              groupTag: before.groupTag || null,
              phone: before.phone || null,
              phoneLookup: before.phoneLookup || null
            };
        after = {
          ...before,
          ...safeForm,
          noShow: false,
          canceled: true,
          cancelComment: "Online booking request declined",
          type: "appointment",
          source: "online_booking",
          status: "declined",
          declinedAt: FieldValue.serverTimestamp(),
          declinedBy: actor.label
        };
        lastAction = "online_request_declined";
      } else {
        lastAction = "delete";
      }

      if (before?.hasPrivateContact === true && !beforePrivate) {
        throw new HttpsError("failed-precondition", "Private appointment contact is unavailable.");
      }

      const managerSubmittedPhone = actor.role === "manager"
        ? String(form?.phone || "").trim()
        : "";
      const normalizedManagerPhone = normalizePhone(managerSubmittedPhone);
      const isPrivateSchemaAppointment = Number(before?.privacySchemaVersion) >= CLIENT_SCHEMA_VERSION;
      const isLegacyOnlineActivation = Boolean(
        after &&
        !beforePrivate &&
        !isPrivateSchemaAppointment &&
        mode !== "delete" &&
        (before?.source === "online_booking" || before?.type === "online_booking_request")
      );
      const legacyOnlineActivationPhone = isLegacyOnlineActivation
        ? (actor.role === "manager" ? managerSubmittedPhone : String(before?.phone || ""))
        : "";
      const managerClearedPrivateContact = Boolean(
        after && actor.role === "manager" && beforePrivate && !managerSubmittedPhone
      );
      if (after && actor.role === "manager" && managerSubmittedPhone && !normalizedManagerPhone) {
        throw new HttpsError("invalid-argument", "Please enter a valid phone number.");
      }
      const shouldCreatePrivateContact = Boolean(
        after &&
        (
          (
            actor.role === "manager" &&
            normalizedManagerPhone
          ) ||
          normalizePhone(legacyOnlineActivationPhone)
        )
      );
      const shouldKeepPrivateContact = Boolean(beforePrivate && !managerClearedPrivateContact);
      const effectivePrivatePhone = actor.role === "manager"
        ? managerSubmittedPhone
        : (beforePrivate?.phoneDisplay || beforePrivate?.phoneNormalized || legacyOnlineActivationPhone);
      let clientIdentity = null;
      if (after && (shouldCreatePrivateContact || shouldKeepPrivateContact)) {
        clientIdentity = await planClientIdentityInTransaction({
          transaction: tx,
          db,
          FieldValue,
          pepper: getClientLookupPepper(),
          phone: effectivePrivatePhone,
          clientName: after.client,
          allowCreate: true,
          allowCloseNameMatch: true
        });
        if (!clientIdentity) {
          throw new HttpsError("invalid-argument", "A valid phone number is required for this client.");
        }
        after = stripPrivateAppointmentFields({
          ...after,
          privacySchemaVersion: CLIENT_SCHEMA_VERSION,
          hasPrivateContact: true
        });
      } else if (after && (mode === "create" || isPrivateSchemaAppointment || beforePrivate)) {
        after = stripPrivateAppointmentFields({
          ...after,
          privacySchemaVersion: CLIENT_SCHEMA_VERSION,
          hasPrivateContact: false
        });
      }

      const mustValidatePlacement = Boolean(
        appointmentUsesSchedule(after, ANYONE_ID) &&
        !hasSameScheduledPlacement(before, after)
      );

      let targetStaffRecord = null;
      if (after?.staffId && after.staffId !== ANYONE_ID && (mustValidatePlacement || clientIdentity)) {
        const targetStaffSnap = await tx.get(db.collection("staff").doc(after.staffId));
        targetStaffRecord = targetStaffSnap.exists
          ? { id: targetStaffSnap.id, ...targetStaffSnap.data() }
          : null;
        if (mustValidatePlacement && (!targetStaffRecord || targetStaffRecord.active === false)) {
          throw new HttpsError("failed-precondition", "Selected technician is not active.");
        }
      }

      if (mustValidatePlacement) {
        const offWorkSnap = await tx.get(db.collection("OffWork").where("date", "==", after.date));
        const weeklyOffSnap = await tx.get(db.collection("WeeklyOff").where("staffId", "==", after.staffId));
        const offWorkRecords = offWorkSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
        const weeklyOffRecords = weeklyOffSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
        if (staffHasOffWork(
          offWorkRecords,
          weeklyOffRecords,
          after.staffId,
          after.date,
          Number(after.start),
          Number(after.start) + Number(after.duration)
        )) {
          throw new HttpsError(
            "failed-precondition",
            "This technician is off during the selected time.",
            { reason: "off-work" }
          );
        }
      }

      const scheduleStates = await loadAppointmentScheduleStates(tx, [before, after].filter(Boolean));
      updateAppointmentScheduleStates(scheduleStates, before, after, appointmentId);

      if (after && clientIdentity) {
        const excludeCurrentHistory = Boolean(
          before && !isPendingOnlineRequest(before) && !isDeclinedOnlineRequest(before)
        );
        const cachedClientSummary = excludeCurrentHistory
          ? null
          : getCachedProfileSummary(clientIdentity.profileData);
        const clientHistory = clientIdentity.clientProfileId && !cachedClientSummary
          ? await loadClientHistoryInTransaction(tx, db, clientIdentity.clientProfileId)
          : [];
        const clientSummary = cachedClientSummary || (
          clientHistory.length
            ? summarizeClientHistory(clientHistory.filter(record => (
                String(record.appointmentId || record.id || "") !== appointmentId
              )))
            : null
        );
        const serviceTextWasEdited = Boolean(
          before && String(before.note || "") !== String(after.note || "")
        );
        if (serviceTextWasEdited) after.selectedServices = [];
        const serviceInput = {
          selectedServices: serviceTextWasEdited
            ? []
            : (Array.isArray(after.selectedServices) ? after.selectedServices : []),
          serviceDetails: after.note || "",
          requestedGroups: getRequestedServiceGroups({
            selectedServices: Array.isArray(after.selectedServices) ? after.selectedServices : [],
            serviceDetails: after.note || ""
          })
        };
        const requestedServiceIntent = parseServiceIntent(serviceInput);
        const durationDecision = targetStaffRecord
          ? getBookingDurationDecision(serviceInput, targetStaffRecord, clientSummary)
          : null;
        const effectiveServiceIntent = durationDecision?.effectiveIntent ||
          applyHistoryPreferences(requestedServiceIntent, clientSummary);
        after.serviceIntent = effectiveServiceIntent;
        after.serviceFingerprint = getServiceFingerprint(effectiveServiceIntent);
        after.bookingStandardDuration = durationDecision?.standardDuration ||
          Number(after.bookingStandardDuration) ||
          Number(after.duration) ||
          null;
      }

      writeAppointmentScheduleStates(tx, scheduleStates);

      if (
        beforePrivate?.clientProfileId &&
        String(beforePrivate.clientProfileId) !== String(clientIdentity?.clientProfileId || "")
      ) {
        invalidateClientProfileSummary(
          tx,
          db,
          FieldValue,
          beforePrivate.clientProfileId
        );
      }

      if (mode === "delete") {
        tx.delete(appointmentRef);
        deleteClientAppointmentRecords(tx, db, appointmentId);
      } else {
        const nextRevision = currentRevision + 1;
        after.lastEditedBy = actor.label;
        after.lastAction = lastAction;
        after.lastActionAt = FieldValue.serverTimestamp();
        after.lastMutationId = mutationId;
        after.lastMutationMode = mode;
        after.revision = nextRevision;
        if (clientIdentity) applyClientIdentityPlan(tx, clientIdentity, FieldValue);
        tx.set(appointmentRef, after);
        if (clientIdentity) {
          writeClientAppointmentRecords(tx, {
            db,
            FieldValue,
            appointmentId,
            appointment: after,
            identity: clientIdentity
          });
        } else if (beforePrivate) {
          deleteClientAppointmentRecords(tx, db, appointmentId);
        }
      }

      return {
        ok: true,
        duplicate: false,
        appointmentId,
        revision: mode === "delete" ? currentRevision : currentRevision + 1,
        lastAction,
        hasPrivateContact: mode !== "delete" && Boolean(clientIdentity)
      };
    });
  }
);

exports.managerGetAppointmentContact = onCall(
  {
    region: "us-central1",
    maxInstances: 10
  },
  async request => {
    await requireManagerActor(request);
    const appointmentId = assertAppointmentToken(
      request.data?.appointmentId,
      "appointmentId",
      { min: 12, max: 100 }
    );
    const [privateSnapshot, appointmentSnapshot] = await Promise.all([
      db.collection(APPOINTMENT_PRIVATE_COLLECTION).doc(appointmentId).get(),
      db.collection("appointments").doc(appointmentId).get()
    ]);
    if (!appointmentSnapshot.exists) {
      throw new HttpsError("not-found", "Appointment no longer exists.");
    }
    const privateData = privateSnapshot.exists ? privateSnapshot.data() || {} : {};
    const legacyData = appointmentSnapshot.data() || {};
    return {
      ok: true,
      appointmentId,
      phone: String(privateData.phoneDisplay || privateData.phoneNormalized || legacyData.phone || ""),
      hasPrivateContact: privateSnapshot.exists,
      hasClientHistory: Boolean(privateData.clientProfileId)
    };
  }
);

function sortAppointmentsNewestFirst(left, right) {
  return String(right?.date || "").localeCompare(String(left?.date || "")) ||
    Number(right?.start || 0) - Number(left?.start || 0);
}

function serializeManagerLookupAppointment(appointment, phone) {
  return {
    ...stripPrivateAppointmentFields(appointment),
    id: String(appointment?.id || ""),
    phone: String(phone || "")
  };
}

function buildManagerPhoneProfiles(phoneClient, historyRecords, legacyAppointments) {
  const recordsByProfile = new Map();
  historyRecords.forEach(record => {
    const profileId = String(record?.clientProfileId || "");
    if (!profileId) return;
    if (!recordsByProfile.has(profileId)) recordsByProfile.set(profileId, []);
    recordsByProfile.get(profileId).push(record);
  });

  const profiles = (phoneClient?.profiles || []).map(profile => {
    const records = recordsByProfile.get(profile.id) || [];
    const latest = [...records].sort(sortAppointmentsNewestFirst)[0] || null;
    return {
      displayName: String(profile.displayName || ""),
      aliases: Array.isArray(profile.aliases) ? profile.aliases.map(String).slice(0, 12) : [],
      appointmentCount: records.length || Math.max(0, Number(profile.historyRecordCount) || 0),
      latestAppointment: latest ? buildManagerClientHistoryAppointment(latest) : null
    };
  });

  const knownNames = new Set(profiles.flatMap(profile => [
    normalizeClientName(profile.displayName),
    ...profile.aliases.map(normalizeClientName)
  ]).filter(Boolean));
  const legacyByName = new Map();
  legacyAppointments.forEach(appointment => {
    const displayName = String(appointment?.client || "").trim();
    const key = normalizeClientName(displayName);
    if (!key || knownNames.has(key)) return;
    const current = legacyByName.get(key) || { displayName, appointments: [] };
    current.appointments.push(appointment);
    legacyByName.set(key, current);
  });
  legacyByName.forEach(value => {
    const latest = [...value.appointments].sort(sortAppointmentsNewestFirst)[0] || null;
    profiles.push({
      displayName: value.displayName,
      aliases: [],
      appointmentCount: value.appointments.length,
      latestAppointment: latest ? buildManagerClientHistoryAppointment(latest) : null,
      legacy: true
    });
  });

  return profiles.sort((left, right) => (
    Number(right.appointmentCount || 0) - Number(left.appointmentCount || 0) ||
    String(left.displayName || "").localeCompare(String(right.displayName || ""))
  ));
}

exports.managerLookupClientByPhone = onCall(
  {
    region: "us-central1",
    maxInstances: 8,
    secrets: [CLIENT_LOOKUP_PEPPER]
  },
  async request => {
    await requireManagerActor(request);
    const submittedPhone = assertString(request.data?.phone, "phone", { min: 7, max: 30 });
    const phoneNormalized = normalizePhone(submittedPhone);
    if (!phoneNormalized) {
      throw new HttpsError("invalid-argument", "Please enter a complete phone number.");
    }
    const includeAppointments = request.data?.includeAppointments === true;
    const phoneDigits = normalizePhoneDigits(phoneNormalized);
    const phoneClient = await readPhoneClient({
      db,
      pepper: getClientLookupPepper(),
      phone: phoneNormalized
    });

    const historySnapshot = phoneClient && includeAppointments
      ? await db.collection(CLIENT_HISTORY_COLLECTION)
          .where("clientId", "==", phoneClient.clientId)
          .limit(120)
          .get()
      : null;
    const historyRecords = historySnapshot
      ? historySnapshot.docs.map(document => ({ id: document.id, ...document.data() }))
      : [];

    const legacyQueries = [];
    const shouldReadLegacyAppointments = includeAppointments || !phoneClient;
    if (shouldReadLegacyAppointments && phoneDigits) {
      legacyQueries.push(
        db.collection("appointments").where("phoneLookup", "==", phoneDigits).limit(120).get()
      );
    }
    const phoneVariants = buildPhoneLookupVariants(submittedPhone).slice(0, 10);
    if (shouldReadLegacyAppointments && phoneVariants.length) {
      legacyQueries.push(
        db.collection("appointments").where("phone", "in", phoneVariants).limit(120).get()
      );
    }
    const legacySnapshots = await Promise.all(legacyQueries);
    const legacyAppointmentsById = new Map();
    legacySnapshots.forEach(snapshot => snapshot.docs.forEach(document => {
      legacyAppointmentsById.set(document.id, { id: document.id, ...document.data() });
    }));
    const legacyAppointments = [...legacyAppointmentsById.values()];

    let appointments = [];
    if (includeAppointments) {
      const appointmentIds = [...new Set([
        ...historyRecords.map(record => record.appointmentId || record.id),
        ...legacyAppointments.map(appointment => appointment.id)
      ].map(String).filter(Boolean))].slice(0, 120);
      const appointmentsById = new Map(legacyAppointments.map(appointment => [appointment.id, appointment]));
      for (let index = 0; index < appointmentIds.length; index += 50) {
        const missingIds = appointmentIds
          .slice(index, index + 50)
          .filter(id => !appointmentsById.has(id));
        if (!missingIds.length) continue;
        const snapshots = await db.getAll(
          ...missingIds.map(id => db.collection("appointments").doc(id))
        );
        snapshots.forEach(snapshot => {
          if (snapshot.exists) appointmentsById.set(snapshot.id, { id: snapshot.id, ...snapshot.data() });
        });
      }
      const displayPhone = String(phoneClient?.client?.phoneDisplay || submittedPhone).trim();
      appointments = [...appointmentsById.values()]
        .sort(sortAppointmentsNewestFirst)
        .slice(0, 120)
        .map(appointment => serializeManagerLookupAppointment(
          appointment,
          appointment.hasPrivateContact === true ? displayPhone : (appointment.phone || displayPhone)
        ));
    }

    const profiles = buildManagerPhoneProfiles(phoneClient, historyRecords, legacyAppointments);
    return {
      ok: true,
      found: Boolean(phoneClient || legacyAppointments.length),
      phone: String(phoneClient?.client?.phoneDisplay || submittedPhone).trim(),
      hasPrivateClient: Boolean(phoneClient),
      profiles,
      appointments
    };
  }
);

exports.managerGetActivityLogContacts = onCall(
  {
    region: "us-central1",
    maxInstances: 6
  },
  async request => {
    await requireManagerActor(request);
    const logDate = assertDate(request.data?.logDate);
    const logSnapshot = await db.collection("activityLog")
      .where("logDate", "==", logDate)
      .limit(150)
      .get();
    const appointmentIds = [...new Set(logSnapshot.docs
      .map(document => document.data() || {})
      .filter(entry => entry.entityType === "appointment")
      .map(entry => String(entry.entityId || ""))
      .filter(id => /^[A-Za-z0-9_-]{12,100}$/.test(id))
    )];
    const contacts = [];
    for (let index = 0; index < appointmentIds.length; index += 50) {
      const ids = appointmentIds.slice(index, index + 50);
      const snapshots = await db.getAll(
        ...ids.map(id => db.collection(APPOINTMENT_PRIVATE_COLLECTION).doc(id))
      );
      snapshots.forEach(snapshot => {
        if (!snapshot.exists) return;
        const data = snapshot.data() || {};
        contacts.push({
          appointmentId: snapshot.id,
          phone: String(data.phoneDisplay || data.phoneNormalized || "")
        });
      });
    }
    return { ok: true, logDate, contacts };
  }
);

function buildManagerClientHistoryAppointment(appointment) {
  const status = appointment.status === "declined"
    ? "Declined"
    : (appointment.noShow === true
        ? "No-show"
        : (appointment.canceled === true ? "Canceled" : ""));
  return {
    id: appointment.id,
    date: String(appointment.date || ""),
    start: Number(appointment.start) || 0,
    duration: Number(appointment.duration) || 0,
    staffId: String(appointment.staffId || ""),
    client: String(appointment.client || ""),
    note: String(appointment.note || ""),
    status,
    source: appointment.source === "online_booking" ? "online_booking" : "calendar"
  };
}

exports.managerGetClientHistory = onCall(
  {
    region: "us-central1",
    maxInstances: 8
  },
  async request => {
    await requireManagerActor(request);
    const appointmentId = assertAppointmentToken(
      request.data?.appointmentId,
      "appointmentId",
      { min: 12, max: 100 }
    );
    const privateSnapshot = await db.collection(APPOINTMENT_PRIVATE_COLLECTION).doc(appointmentId).get();
    if (!privateSnapshot.exists || !privateSnapshot.data()?.clientProfileId) {
      return { ok: true, appointmentId, available: false, past: [], future: [], totalCount: 0 };
    }
    const privateData = privateSnapshot.data() || {};
    const historySnapshot = await db.collection(CLIENT_HISTORY_COLLECTION)
      .where("clientProfileId", "==", String(privateData.clientProfileId))
      .limit(120)
      .get();
    const appointmentIds = historySnapshot.docs
      .map(document => document.id)
      .filter(id => id !== appointmentId);
    const appointments = [];
    for (let index = 0; index < appointmentIds.length; index += 50) {
      const snapshots = await db.getAll(
        ...appointmentIds.slice(index, index + 50).map(id => db.collection("appointments").doc(id))
      );
      snapshots.forEach(snapshot => {
        if (snapshot.exists) appointments.push({ id: snapshot.id, ...snapshot.data() });
      });
    }
    const today = getSalonNowParts().date;
    const past = appointments
      .filter(item => String(item.date || "") < today)
      .sort((left, right) => String(right.date).localeCompare(String(left.date)) || Number(right.start) - Number(left.start));
    const future = appointments
      .filter(item => String(item.date || "") >= today)
      .sort((left, right) => String(left.date).localeCompare(String(right.date)) || Number(left.start) - Number(right.start));
    const summary = summarizeClientHistory(historySnapshot.docs.map(document => ({
      id: document.id,
      ...document.data()
    })));
    return {
      ok: true,
      appointmentId,
      available: true,
      phone: String(privateData.phoneDisplay || privateData.phoneNormalized || ""),
      summary,
      past: past.slice(0, 10).map(buildManagerClientHistoryAppointment),
      future: future.slice(0, 10).map(buildManagerClientHistoryAppointment),
      totalCount: appointments.length
    };
  }
);

exports.clientHistorySummaryUpdated = onDocumentWritten(
  {
    document: `${CLIENT_HISTORY_COLLECTION}/{appointmentId}`,
    region: "us-central1",
    maxInstances: 6
  },
  async event => {
    const before = event.data?.before?.exists ? event.data.before.data() || {} : {};
    const after = event.data?.after?.exists ? event.data.after.data() || {} : {};
    const profileIds = [...new Set([
      String(before.clientProfileId || ""),
      String(after.clientProfileId || "")
    ].filter(Boolean))];

    const afterUpdateTime = event.data?.after?.updateTime;
    const summaryEventMillis = afterUpdateTime?.toMillis
      ? afterUpdateTime.toMillis()
      : (Date.parse(String(event.time || "")) || Date.now());
    await Promise.all(profileIds.map(async clientProfileId => {
      const historySnapshot = await db.collection(CLIENT_HISTORY_COLLECTION)
        .where("clientProfileId", "==", clientProfileId)
        .limit(120)
        .get();
      const records = historySnapshot.docs.map(document => ({
        id: document.id,
        ...document.data()
      }));
      const profileRef = db.collection(CLIENT_PROFILE_COLLECTION).doc(clientProfileId);
      const summary = summarizeClientHistory(records);
      await db.runTransaction(async transaction => {
        const profileSnapshot = await transaction.get(profileRef);
        const previousEventMillis = Number(profileSnapshot.data()?.historySummaryEventMillis) || 0;
        const dirtyAt = profileSnapshot.data()?.historySummaryDirtyAt;
        const dirtyAtMillis = dirtyAt?.toMillis ? dirtyAt.toMillis() : 0;
        if (previousEventMillis > summaryEventMillis || dirtyAtMillis > summaryEventMillis) return;
        transaction.set(profileRef, {
          historySummaryVersion: CLIENT_SUMMARY_VERSION,
          historySummary: summary,
          historyRecordCount: records.length,
          historySummaryTruncated: historySnapshot.size >= 120,
          historySummaryEventMillis: summaryEventMillis,
          historySummaryDirtyAt: FieldValue.delete(),
          historySummaryUpdatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      });
    }));
  }
);

exports.auditAppointmentOverlaps = onCall(
  {
    region: "us-central1",
    maxInstances: 2
  },
  async (request) => {
    const actor = await getAuthorizedCalendarActor(request);
    if (actor.role !== "manager") {
      throw new HttpsError("permission-denied", "Only a manager can run the overlap audit.");
    }

    const input = request.data || {};
    const startDate = assertDate(input.startDate);
    const endDate = assertDate(input.endDate || input.startDate);
    const dayCount = Math.round((getLocalDate(endDate) - getLocalDate(startDate)) / 86400000) + 1;
    if (dayCount < 1 || dayCount > 31) {
      throw new HttpsError("invalid-argument", "Audit range must contain 1 to 31 days.");
    }

    const appointmentsSnap = await db.collection("appointments")
      .where("date", ">=", startDate)
      .where("date", "<=", endDate)
      .get();
    const appointments = appointmentsSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
    const groups = new Map();

    appointments
      .filter(appointment => appointmentUsesSchedule(appointment, ANYONE_ID))
      .forEach(appointment => {
        const key = getScheduleId(appointment.date, appointment.staffId);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(appointment);
      });

    const conflicts = [];
    for (const groupAppointments of groups.values()) {
      const sample = groupAppointments[0];
      const slots = buildScheduleSlots(groupAppointments, {
        date: sample.date,
        staffId: sample.staffId,
        anyoneId: ANYONE_ID
      });
      const collapsed = new Map();
      findScheduleOverlaps(slots).forEach(overlap => {
        const signature = overlap.appointmentIds.join("|");
        if (!collapsed.has(signature)) {
          collapsed.set(signature, {
            date: sample.date,
            staffId: sample.staffId,
            appointmentIds: overlap.appointmentIds,
            slots: []
          });
        }
        collapsed.get(signature).slots.push(Number(overlap.slotKey.replace("slot_", "")));
      });
      conflicts.push(...collapsed.values());
    }

    return {
      ok: true,
      startDate,
      endDate,
      scannedAppointments: appointments.length,
      conflictCount: conflicts.length,
      conflicts: conflicts.slice(0, 100),
      truncated: conflicts.length > 100
    };
  }
);

function getBookingManagementIdentity(input, { requireConsent = false } = {}) {
  const client = assertString(input?.client, "client", { min: 2, max: 80 });
  const phone = assertString(input?.phone, "phone", { min: 7, max: 30 });
  if (requireConsent && input?.consentAccepted !== true) {
    throw new HttpsError("invalid-argument", "Consent is required.");
  }

  const phoneDigits = normalizePhoneDigits(phone);
  const clientName = normalizeClientName(client);
  if (!phoneDigits) {
    throw new HttpsError("invalid-argument", "Please enter a valid phone number.");
  }
  if (!clientName) {
    throw new HttpsError("invalid-argument", "Please enter your name.");
  }

  return { client, phone, phoneDigits, clientName };
}

function getBookingVerificationIdentityId(phoneDigits, clientName) {
  return crypto
    .createHash("sha256")
    .update(`${phoneDigits}\n${clientName}`)
    .digest("hex");
}

function getBookingVerificationCodeSecret() {
  const secret = TWILIO_AUTH_TOKEN.value();
  if (!secret) {
    throw new HttpsError("unavailable", "Phone verification is temporarily unavailable.");
  }
  return secret;
}

function maskBookingPhone(phoneDigits) {
  return `••• ••• ${String(phoneDigits || "").slice(-4) || "0000"}`;
}

function isUpcomingOnlineAppointmentRecord(appointment, salonNow) {
  if (!appointment || appointment.canceled === true || appointment.noShow === true) return false;
  if (!["request", "confirmed"].includes(String(appointment.status || ""))) return false;
  if (appointment.source !== "online_booking" && appointment.type !== "online_booking_request") return false;
  const date = String(appointment.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < salonNow.date) return false;
  if (date > salonNow.date) return true;
  const start = Number(appointment.start);
  if (!Number.isFinite(start) || start < 0) return true;
  return (8 * 60) + (start * 15) >= salonNow.minutes;
}

async function loadUpcomingAppointmentsForClient({ phone, phoneDigits, clientName, pepper = "", clientProfileId = "" }) {
  const phoneVariants = buildPhoneLookupVariants(phone || phoneDigits);
  const queries = [
    db.collection("appointments")
      .where("phoneLookup", "==", phoneDigits)
      .limit(75)
      .get()
  ];
  if (phoneVariants.length) {
    queries.push(
      db.collection("appointments")
        .where("phone", "in", phoneVariants)
        .limit(75)
        .get()
    );
  }

  const snapshots = await Promise.all(queries);
  const candidates = new Map();
  const privateIdentityAppointmentIds = new Set();
  snapshots.forEach(snapshot => {
    snapshot.docs.forEach(docSnap => {
      candidates.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
    });
  });

  let resolvedProfileId = String(clientProfileId || "");
  if (!resolvedProfileId && pepper) {
    const identity = await readClientIdentity({
      db,
      pepper,
      phone: phone || phoneDigits,
      clientName,
      allowCloseNameMatch: true
    });
    resolvedProfileId = String(identity?.profile?.id || "");
  }
  if (resolvedProfileId) {
    const historySnapshot = await db.collection(CLIENT_HISTORY_COLLECTION)
      .where("clientProfileId", "==", resolvedProfileId)
      .limit(75)
      .get();
    const appointmentIds = historySnapshot.docs.map(document => document.id);
    if (appointmentIds.length) {
      const appointmentSnapshots = await db.getAll(
        ...appointmentIds.map(id => db.collection("appointments").doc(id))
      );
      appointmentSnapshots.forEach(snapshot => {
        if (!snapshot.exists) return;
        privateIdentityAppointmentIds.add(snapshot.id);
        candidates.set(snapshot.id, { id: snapshot.id, ...snapshot.data() });
      });
    }
  }

  const salonNow = getSalonNowParts();
  return Array.from(candidates.values())
    .filter(appointment => privateIdentityAppointmentIds.has(appointment.id)
      ? isUpcomingOnlineAppointmentRecord(appointment, salonNow)
      : isUpcomingAppointmentForClient(appointment, {
          phoneDigits,
          clientName,
          today: salonNow.date,
          currentMinutes: salonNow.minutes
        }))
    .sort((left, right) => {
      const dateComparison = String(left.date || "").localeCompare(String(right.date || ""));
      return dateComparison || (Number(left.start) || 0) - (Number(right.start) || 0);
    });
}

function buildBookingManagementAppointment(appointment, staffRecords) {
  const selectedServiceText = Array.isArray(appointment.selectedServices)
    ? appointment.selectedServices.map(item => String(item || "").trim()).filter(Boolean).join(", ")
    : "";
  const start = Number(appointment.start);
  return {
    id: appointment.id,
    status: appointment.status === "confirmed" ? "confirmed" : "request",
    date: String(appointment.date || ""),
    time: Number.isFinite(start) && start >= 0 ? slotToTime(start) : "Morning",
    technician: getStaffName(staffRecords, appointment.staffId),
    service: String(appointment.note || selectedServiceText || "Service details not provided").trim().slice(0, 600)
  };
}

exports.checkUpcomingAppointments = onCall(
  {
    region: "us-central1",
    maxInstances: 10,
    secrets: [CLIENT_LOOKUP_PEPPER]
  },
  async (request) => {
    const identity = getBookingManagementIdentity(request.data || {}, { requireConsent: true });
    const appointments = await loadUpcomingAppointmentsForClient({
      ...identity,
      pepper: getClientLookupPepper()
    });
    return {
      ok: true,
      hasUpcomingAppointments: appointments.length > 0
    };
  }
);

exports.sendOnlineBookingVerificationCode = onCall(
  {
    region: "us-central1",
    maxInstances: 10,
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, CLIENT_LOOKUP_PEPPER]
  },
  async (request) => {
    const identity = getBookingManagementIdentity(request.data || {}, { requireConsent: true });
    const storedIdentity = await readClientIdentity({
      db,
      pepper: getClientLookupPepper(),
      phone: identity.phone,
      clientName: identity.clientName,
      allowCloseNameMatch: true
    });
    const appointments = await loadUpcomingAppointmentsForClient({
      ...identity,
      pepper: getClientLookupPepper(),
      clientProfileId: storedIdentity?.profile?.id || ""
    });
    if (!appointments.length) {
      throw new HttpsError("not-found", "No upcoming online booking appointments were found.");
    }

    const secret = getBookingVerificationCodeSecret();
    const nowMs = Date.now();
    const challengeRef = db.collection(BOOKING_VERIFICATION_COLLECTION).doc();
    const identityId = getBookingVerificationIdentityId(identity.phoneDigits, identity.clientName);
    const rateRef = db.collection(BOOKING_VERIFICATION_RATE_COLLECTION).doc(identityId);
    const code = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
    const codeHash = buildVerificationCodeHash({ challengeId: challengeRef.id, code, secret });
    const expiresAtMs = nowMs + BOOKING_VERIFICATION_CODE_TTL_MS;
    const cleanupAtMs = nowMs + BOOKING_VERIFICATION_CLEANUP_TTL_MS;
    let challengeReserved = false;

    await db.runTransaction(async tx => {
      const rateSnap = await tx.get(rateRef);
      const decision = getVerificationRateDecision(rateSnap.exists ? rateSnap.data() : null, nowMs);
      if (!decision.allowed) {
        const message = decision.reason === "cooldown"
          ? `Please wait ${decision.retryAfterSeconds} seconds before requesting another code.`
          : "Too many verification codes were requested. Please try again later.";
        throw new HttpsError("resource-exhausted", message, {
          reason: decision.reason,
          retryAfterSeconds: decision.retryAfterSeconds
        });
      }

      tx.set(rateRef, {
        sendCount: decision.sendCount,
        windowStartedAt: admin.firestore.Timestamp.fromMillis(decision.windowStartedAtMs),
        dailySendCount: decision.dailySendCount,
        dailyWindowStartedAt: admin.firestore.Timestamp.fromMillis(decision.dailyWindowStartedAtMs),
        lastSentAt: admin.firestore.Timestamp.fromMillis(decision.lastSentAtMs),
        latestChallengeId: challengeRef.id,
        cleanupAt: admin.firestore.Timestamp.fromMillis(cleanupAtMs)
      }, { merge: true });
      tx.set(challengeRef, {
        identityId,
        clientId: storedIdentity?.clientId || null,
        clientProfileId: storedIdentity?.profile?.id || null,
        phoneDigits: identity.phoneDigits,
        clientName: identity.clientName,
        codeHash,
        attempts: 0,
        status: "sending",
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(expiresAtMs),
        cleanupAt: admin.firestore.Timestamp.fromMillis(cleanupAtMs)
      });
    });
    challengeReserved = true;

    try {
      const result = await sendSmsViaTwilio({
        to: normalizePhoneToE164(identity.phoneDigits),
        body: `Rose's Nails verification code: ${code}. It expires in 10 minutes. Do not share this code.`
      });
      if (result?.skipped) {
        throw new Error(result.reason || "twilio_not_configured");
      }

      await challengeRef.set({
        status: "active",
        sentAt: FieldValue.serverTimestamp(),
        providerMessageId: result?.providerMessageId || null
      }, { merge: true });

      return {
        ok: true,
        challengeId: challengeRef.id,
        maskedPhone: maskBookingPhone(identity.phoneDigits),
        expiresInSeconds: Math.floor(BOOKING_VERIFICATION_CODE_TTL_MS / 1000)
      };
    } catch (error) {
      if (challengeReserved) {
        await challengeRef.set({
          status: "failed",
          failedAt: FieldValue.serverTimestamp(),
          codeHash: FieldValue.delete()
        }, { merge: true }).catch(() => null);
      }
      console.error("Online booking verification SMS failed", {
        challengeId: challengeRef.id,
        phoneLast4: getPhoneLast4(identity.phoneDigits),
        error: error && error.message ? error.message : String(error)
      });
      throw new HttpsError("unavailable", "We could not send a verification code right now. Please try again.");
    }
  }
);

exports.verifyOnlineBookingCode = onCall(
  {
    region: "us-central1",
    maxInstances: 10,
    secrets: [TWILIO_AUTH_TOKEN, CLIENT_LOOKUP_PEPPER]
  },
  async (request) => {
    const input = request.data || {};
    const challengeId = assertAppointmentToken(input.challengeId, "challengeId", { min: 12, max: 100 });
    const code = assertString(input.code, "code", { min: 6, max: 6 });
    if (!/^\d{6}$/.test(code)) {
      throw new HttpsError("invalid-argument", "Enter the six-digit verification code.");
    }

    const secret = getBookingVerificationCodeSecret();
    const challengeRef = db.collection(BOOKING_VERIFICATION_COLLECTION).doc(challengeId);
    const sessionToken = crypto.randomBytes(32).toString("base64url");
    const sessionTokenHash = buildSessionTokenHash(sessionToken);
    const nowMs = Date.now();
    const sessionExpiresAtMs = nowMs + BOOKING_VERIFICATION_SESSION_TTL_MS;

    const verification = await db.runTransaction(async tx => {
      const challengeSnap = await tx.get(challengeRef);
      if (!challengeSnap.exists) return { ok: false, reason: "expired" };

      const challenge = challengeSnap.data() || {};
      const rateRef = challenge.identityId
        ? db.collection(BOOKING_VERIFICATION_RATE_COLLECTION).doc(String(challenge.identityId))
        : null;
      const rateSnap = rateRef ? await tx.get(rateRef) : null;
      if (!rateSnap?.exists || rateSnap.data()?.latestChallengeId !== challengeId) {
        tx.set(challengeRef, {
          status: "superseded",
          supersededAt: FieldValue.serverTimestamp(),
          codeHash: FieldValue.delete()
        }, { merge: true });
        return { ok: false, reason: "expired" };
      }

      const expiresAtMs = challenge.expiresAt?.toMillis ? challenge.expiresAt.toMillis() : 0;
      if (challenge.status !== "active" || !expiresAtMs || expiresAtMs <= nowMs) {
        if (challenge.status === "active") {
          tx.set(challengeRef, {
            status: "expired",
            expiredAt: FieldValue.serverTimestamp(),
            codeHash: FieldValue.delete()
          }, { merge: true });
        }
        return { ok: false, reason: "expired" };
      }

      const attempts = Math.max(0, Number(challenge.attempts) || 0);
      if (attempts >= BOOKING_VERIFICATION_MAX_ATTEMPTS) {
        return { ok: false, reason: "locked" };
      }

      const submittedHash = buildVerificationCodeHash({ challengeId, code, secret });
      if (!secureHashesEqual(challenge.codeHash, submittedHash)) {
        const nextAttempts = attempts + 1;
        tx.set(challengeRef, {
          attempts: nextAttempts,
          lastAttemptAt: FieldValue.serverTimestamp(),
          status: nextAttempts >= BOOKING_VERIFICATION_MAX_ATTEMPTS ? "locked" : "active",
          ...(nextAttempts >= BOOKING_VERIFICATION_MAX_ATTEMPTS
            ? { codeHash: FieldValue.delete(), lockedAt: FieldValue.serverTimestamp() }
            : {})
        }, { merge: true });
        return {
          ok: false,
          reason: nextAttempts >= BOOKING_VERIFICATION_MAX_ATTEMPTS ? "locked" : "incorrect"
        };
      }

      tx.set(challengeRef, {
        status: "verified",
        verifiedAt: FieldValue.serverTimestamp(),
        codeHash: FieldValue.delete(),
        sessionTokenHash,
        sessionExpiresAt: admin.firestore.Timestamp.fromMillis(sessionExpiresAtMs),
        cleanupAt: admin.firestore.Timestamp.fromMillis(sessionExpiresAtMs + BOOKING_VERIFICATION_CLEANUP_TTL_MS)
      }, { merge: true });

      return {
        ok: true,
        phoneDigits: String(challenge.phoneDigits || ""),
        clientName: String(challenge.clientName || ""),
        clientId: String(challenge.clientId || ""),
        clientProfileId: String(challenge.clientProfileId || "")
      };
    });

    if (!verification.ok) {
      const message = verification.reason === "incorrect"
        ? "The verification code is incorrect. Please try again."
        : "This verification code has expired or can no longer be used. Please send a new code.";
      throw new HttpsError(
        verification.reason === "incorrect" ? "unauthenticated" : "failed-precondition",
        message,
        { reason: verification.reason }
      );
    }

    const appointments = await loadUpcomingAppointmentsForClient({
      phone: verification.phoneDigits,
      phoneDigits: verification.phoneDigits,
      clientName: verification.clientName,
      clientProfileId: verification.clientProfileId || "",
      pepper: getClientLookupPepper()
    });
    const staffSnap = await db.collection("staff").get();
    const staffRecords = staffSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));

    return {
      ok: true,
      challengeId,
      sessionToken,
      sessionExpiresAt: new Date(sessionExpiresAtMs).toISOString(),
      appointments: appointments.map(appointment => buildBookingManagementAppointment(appointment, staffRecords))
    };
  }
);

exports.cancelOnlineBookingAppointment = onCall(
  {
    region: "us-central1",
    maxInstances: 10
  },
  async (request) => {
    const input = request.data || {};
    const challengeId = assertAppointmentToken(input.challengeId, "challengeId", { min: 12, max: 100 });
    const sessionToken = assertAppointmentToken(input.sessionToken, "sessionToken", { min: 32, max: 200 });
    const appointmentId = assertAppointmentToken(input.appointmentId, "appointmentId", { min: 12, max: 100 });
    const challengeRef = db.collection(BOOKING_VERIFICATION_COLLECTION).doc(challengeId);
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const privateAppointmentRef = db.collection(APPOINTMENT_PRIVATE_COLLECTION).doc(appointmentId);
    const logRef = db.collection("activityLog").doc();
    const staffMessageRef = db.collection("staffMessages").doc();
    const sessionTokenHash = buildSessionTokenHash(sessionToken);
    const salonNow = getSalonNowParts();
    const nowMs = Date.now();
    const mutationId = `online_cancel_${crypto.randomBytes(12).toString("base64url")}`;

    return db.runTransaction(async tx => {
      const challengeSnap = await tx.get(challengeRef);
      if (!challengeSnap.exists) {
        throw new HttpsError("unauthenticated", "Your secure session has expired. Please verify your phone again.");
      }
      const challenge = challengeSnap.data() || {};
      const sessionExpiresAtMs = challenge.sessionExpiresAt?.toMillis ? challenge.sessionExpiresAt.toMillis() : 0;
      if (
        challenge.status !== "verified" ||
        !sessionExpiresAtMs ||
        sessionExpiresAtMs <= nowMs ||
        !secureHashesEqual(challenge.sessionTokenHash, sessionTokenHash)
      ) {
        throw new HttpsError("unauthenticated", "Your secure session has expired. Please verify your phone again.");
      }

      const appointmentSnap = await tx.get(appointmentRef);
      if (!appointmentSnap.exists) {
        throw new HttpsError("not-found", "This appointment is no longer available.");
      }
      const before = appointmentSnap.data() || {};
      const privateAppointmentSnap = before.hasPrivateContact === true
        ? await tx.get(privateAppointmentRef)
        : null;
      const privateAppointment = privateAppointmentSnap?.exists
        ? privateAppointmentSnap.data() || {}
        : null;
      const previouslyManagedIds = Array.isArray(challenge.managedAppointmentIds)
        ? challenge.managedAppointmentIds
        : [];
      if (
        before.canceled === true &&
        before.cancelComment === ONLINE_BOOKING_CLIENT_CANCEL_COMMENT &&
        previouslyManagedIds.includes(appointmentId)
      ) {
        return {
          ok: true,
          duplicate: true,
          appointmentId,
          comment: ONLINE_BOOKING_CLIENT_CANCEL_COMMENT
        };
      }
      const linkedPrivateAppointment = Boolean(
        privateAppointment?.clientProfileId &&
        challenge.clientProfileId &&
        String(privateAppointment.clientProfileId) === String(challenge.clientProfileId) &&
        isUpcomingOnlineAppointmentRecord(before, salonNow)
      );
      const linkedLegacyAppointment = !privateAppointment && isUpcomingAppointmentForClient(before, {
        phoneDigits: String(challenge.phoneDigits || ""),
        clientName: String(challenge.clientName || ""),
        today: salonNow.date,
        currentMinutes: salonNow.minutes
      });
      if (!linkedPrivateAppointment && !linkedLegacyAppointment) {
        throw new HttpsError("failed-precondition", "This appointment is no longer available to manage.");
      }

      const staffSnap = await tx.get(db.collection("staff"));
      const staffRecords = staffSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
      const cancellationState = getClientCancellationRecordState(before);
      const after = {
        ...before,
        ...cancellationState,
        cancelComment: ONLINE_BOOKING_CLIENT_CANCEL_COMMENT,
        canceledAt: FieldValue.serverTimestamp(),
        canceledBy: "Online Booking Client",
        lastEditedBy: "Online Booking Client",
        lastAction: "cancel",
        lastActionAt: FieldValue.serverTimestamp(),
        lastMutationId: mutationId,
        lastMutationMode: "online_client_cancel",
        revision: (Number(before.revision) || 0) + 1
      };

      const scheduleStates = await loadAppointmentScheduleStates(tx, [before, after]);
      updateAppointmentScheduleStates(scheduleStates, before, after, appointmentId);

      writeAppointmentScheduleStates(tx, scheduleStates);
      tx.set(appointmentRef, after);
      if (privateAppointment) {
        writeClientAppointmentRecords(tx, {
          db,
          FieldValue,
          appointmentId,
          appointment: after,
          identity: {
            clientId: privateAppointment.clientId,
            clientProfileId: privateAppointment.clientProfileId,
            phoneNormalized: privateAppointment.phoneNormalized,
            phoneDisplay: privateAppointment.phoneDisplay,
            phoneLast4: privateAppointment.phoneLast4,
            phoneKey: privateAppointment.phoneHash
          }
        });
      }
      tx.set(logRef, {
        createdAt: FieldValue.serverTimestamp(),
        logDate: before.date,
        actorLabel: "Online Booking Client",
        actorKey: "online_booking_client",
        staffId: before.staffId,
        eventType: "canceled",
        entityType: "appointment",
        entityId: appointmentId,
        client: before.client,
        phone: before.hasPrivateContact === true ? null : (before.phone || null),
        service: before.note || "",
        details: `${buildAppointmentLogDetails(before, staffRecords)}; canceled; ${ONLINE_BOOKING_CLIENT_CANCEL_COMMENT}`,
        source: "online_booking"
      });

      const staffName = getStaffName(staffRecords, before.staffId);
      const message = `Appointment for ${before.client || "Client"} with ${staffName} was canceled. ${ONLINE_BOOKING_CLIENT_CANCEL_COMMENT}`;
      tx.set(staffMessageRef, buildCanonicalStaffMessageDoc({
        message,
        eventType: "canceled",
        entityType: "appointment",
        entityId: appointmentId,
        staffId: before.staffId,
        staffName,
        staffRecords,
        source: "online_booking",
        messageGroupId: `online-booking-cancel-${appointmentId}`
      }));
      tx.set(challengeRef, {
        sessionLastUsedAt: FieldValue.serverTimestamp(),
        managedAppointmentIds: FieldValue.arrayUnion(appointmentId)
      }, { merge: true });

      return {
        ok: true,
        appointmentId,
        comment: ONLINE_BOOKING_CLIENT_CANCEL_COMMENT
      };
    });
  }
);

exports.createOnlineBookingRequest = onCall(
  {
    region: "us-central1",
    maxInstances: 5,
    secrets: [CLIENT_LOOKUP_PEPPER]
  },
  async (request) => {
    const input = request.data || {};

    const requestId = assertString(input.requestId, "requestId", { min: 12, max: 80 });
    if (!/^[A-Za-z0-9_-]+$/.test(requestId)) {
      throw new HttpsError("invalid-argument", "Invalid requestId.");
    }

    const client = assertString(input.client, "client", { min: 2, max: 80 });
    const phone = assertString(input.phone, "phone", { min: 7, max: 30 });
    if (!normalizePhone(phone)) {
      throw new HttpsError("invalid-argument", "A valid phone number is required.");
    }
    const email = normalizeOptionalEmail(input.email);
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
    const consentVersion = String(input.consentVersion || "").trim();

    if (input.consentAccepted !== true) {
      throw new HttpsError("invalid-argument", "Consent is required.");
    }
    if (consentVersion !== PRIVACY_CONSENT_VERSION) {
      throw new HttpsError(
        "failed-precondition",
        "Privacy details have been updated. Please refresh the booking page and try again."
      );
    }

    if (!serviceDetails && !selectedServices.length) {
      throw new HttpsError("invalid-argument", "Service details are required.");
    }

    const requestedDate = getLocalDate(date);
    if (Number.isNaN(requestedDate.getTime())) {
      throw new HttpsError("invalid-argument", "Invalid date.");
    }

    if (!isBookableOnlineStart({ date, start, duration: 1 })) {
      throw new HttpsError("failed-precondition", "Please choose an available time at least 1 hour ahead.");
    }

    const submissionRef = db.collection("onlineBookingSubmissions").doc(requestId);
    const appointmentRef = db.collection("appointments").doc();
    const logRef = db.collection("activityLog").doc();
    const telegramRef = TELEGRAM_NOTIFICATIONS_PAUSED
      ? null
      : db.collection("TelegramQueue").doc();
    const staffMessageRef = db.collection("staffMessages").doc();
    const emailRef = email ? db.collection(EMAIL_QUEUE_COLLECTION).doc() : null;
    const emailContactRef = email ? db.collection(BOOKING_EMAIL_CONTACT_COLLECTION).doc(appointmentRef.id) : null;
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

      const clientIdentity = await planClientIdentityInTransaction({
        transaction: tx,
        db,
        FieldValue,
        pepper: getClientLookupPepper(),
        phone,
        clientName: client,
        allowCreate: true,
        allowCloseNameMatch: true
      });
      const cachedClientSummary = getCachedProfileSummary(clientIdentity?.profileData);
      const clientHistory = clientIdentity?.clientProfileId && !cachedClientSummary
        ? await loadClientHistoryInTransaction(tx, db, clientIdentity.clientProfileId)
        : [];
      const clientSummary = cachedClientSummary || (
        clientHistory.length ? summarizeClientHistory(clientHistory) : null
      );

      const staffSnap = await tx.get(db.collection("staff"));
      const staffRecords = getActiveStaffRecords(staffSnap.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      })));

      const realStaffIds = new Set(staffRecords.map(s => s.id));
      if (staffId !== ANYONE_ID && !realStaffIds.has(staffId)) {
        throw new HttpsError("invalid-argument", "Selected technician is not available.");
      }

      const selectedStaff = staffRecords.find(s => s.id === staffId);
      if (
        staffId !== ANYONE_ID &&
        (!selectedStaff || selectedStaff.bookingEnabled === false || !staffCanDoServiceGroups(selectedStaff, requestedGroups))
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

      const requestedServiceIntent = parseServiceIntent({
        selectedServices,
        serviceDetails,
        requestedGroups
      });
      let effectiveServiceIntent = applyHistoryPreferences(requestedServiceIntent, clientSummary);
      let serviceFingerprint = getServiceFingerprint(effectiveServiceIntent);
      let duration = BOOKING_DURATION;
      let standardDuration = BOOKING_DURATION;
      let onlineScheduleState = null;
      if (staffId === ANYONE_ID) {
        duration = ANYONE_DISPLAY_DURATION;
        if (!isBookableOnlineStart({ date, start, duration: ANYONE_REQUIRED_DURATION })) {
          throw new HttpsError("failed-precondition", "This time is no longer available.");
        }
        const remainingCapacity = getAnyoneRemainingCapacity({
          date,
          start,
          appointments,
          staffRecords,
          offWorkRecords,
          weeklyOffRecords,
          requestedGroups,
          durationInput: { selectedServices, serviceDetails },
          clientSummary
        });

        if (remainingCapacity <= 0) {
          throw new HttpsError("failed-precondition", "This time is no longer available.");
        }
      } else {
        const durationDecision = getBookingDurationDecision({
          selectedServices,
          serviceDetails,
          requestedGroups
        }, selectedStaff, clientSummary);
        duration = durationDecision.duration;
        standardDuration = durationDecision.standardDuration;
        effectiveServiceIntent = durationDecision.effectiveIntent;
        serviceFingerprint = durationDecision.serviceFingerprint;
        if (!isBookableOnlineStart({ date, start, duration })) {
          throw new HttpsError("failed-precondition", "This time is no longer available.");
        }
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

        const scheduleRef = db.collection(APPOINTMENT_SCHEDULE_COLLECTION)
          .doc(getScheduleId(date, staffId));
        const scheduleSnap = await tx.get(scheduleRef);
        const scheduleSlots = scheduleSnap.exists
          ? cloneSlots(scheduleSnap.data()?.slots)
          : buildScheduleSlots(appointments, { date, staffId, anyoneId: ANYONE_ID });
        try {
          onlineScheduleState = {
            ref: scheduleRef,
            slots: reserveAppointmentSlots(scheduleSlots, {
              id: appointmentRef.id,
              date,
              staffId,
              start,
              duration,
              canceled: false,
              noShow: false
            }, appointmentRef.id)
          };
        } catch (error) {
          if (error?.code === "appointment-conflict") {
            throw new HttpsError("failed-precondition", "This time is no longer available.");
          }
          throw error;
        }
      }

      const appointmentData = stripPrivateAppointmentFields({
        date,
        staffId,
        phone,
        phoneLookup: normalizePhoneDigits(phone),
        clientId: clientIdentity?.clientId || null,
        clientProfileId: clientIdentity?.clientProfileId || null,
        privacySchemaVersion: CLIENT_SCHEMA_VERSION,
        hasPrivateContact: true,
        emailProvided: Boolean(email),
        start,
        duration,
        bookingStandardDuration: standardDuration,
        serviceFingerprint,
        serviceIntent: effectiveServiceIntent,
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
        consentVersion,
        consentSource: "online_booking",
        consentPurpose: "appointment_related_contact_only",
        phoneContactConsent: true,
        smsConsent: true,
        marketingConsent: false,
        consentAcceptedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        createdMutationId: requestId,
        lastMutationId: requestId,
        lastMutationMode: "online_create",
        revision: 1,
        lastEditedBy: "Online Booking",
        lastAction: "online_request_created",
        lastActionAt: FieldValue.serverTimestamp()
      });

      if (onlineScheduleState) {
        tx.set(onlineScheduleState.ref, {
          schemaVersion: SCHEDULE_SCHEMA_VERSION,
          date,
          staffId,
          slots: onlineScheduleState.slots,
          updatedAt: FieldValue.serverTimestamp()
        });
      }

      applyClientIdentityPlan(tx, clientIdentity, FieldValue);
      tx.set(appointmentRef, appointmentData);
      writeClientAppointmentRecords(tx, {
        db,
        FieldValue,
        appointmentId: appointmentRef.id,
        appointment: appointmentData,
        identity: clientIdentity
      });
      tx.set(submissionRef, {
        appointmentId: appointmentRef.id,
        emailProvided: Boolean(email),
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
        entityId: appointmentRef.id,
        client,
        hasPrivateContact: true,
        emailProvided: Boolean(email),
        service: appointmentData.note,
        details: buildAppointmentLogDetails(appointmentData, staffRecords)
      });

      if (emailContactRef) {
        tx.set(emailContactRef, buildBookingEmailContactDoc({
          email,
          appointmentId: appointmentRef.id,
          requestId
        }));
      }

      if (emailRef) {
        tx.set(emailRef, buildBookingEmailQueueDoc({
          eventType: "booking_request_received",
          appointmentId: appointmentRef.id,
          appointmentData: { ...appointmentData, phone },
          staffRecords,
          email
        }));
      }

      const onlineBookingTelegramMessage = buildOnlineBookingTelegramMessage(appointmentData, staffRecords);
      const messageGroupId = `online-booking-${appointmentRef.id}`;
      if (telegramRef) {
        tx.set(telegramRef, {
          status: "pending",
          message: onlineBookingTelegramMessage,
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
      }

      tx.set(staffMessageRef, buildCanonicalStaffMessageDoc({
        message: onlineBookingTelegramMessage,
        eventType: "online_request_created",
        entityType: "appointment",
        entityId: appointmentRef.id,
        staffId,
        staffName: getStaffName(staffRecords, staffId),
        staffRecords,
        photoReviewUrl: appointmentData.photoReviewUrl || "",
        source: "online_booking",
        messageGroupId
      }));

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

exports.emailQueueCreated = onDocumentCreated(
  {
    document: `${EMAIL_QUEUE_COLLECTION}/{id}`,
    secrets: [GMAIL_APP_PASSWORD]
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const ref = snap.ref;
    const data = snap.data() || {};
    if (data.status && data.status !== "pending") return;
    if (!data.to) {
      await ref.set({
        status: "skipped",
        skippedAt: FieldValue.serverTimestamp(),
        error: "missing_recipient"
      }, { merge: true });
      return;
    }

    try {
      const result = await sendBookingEmail(data);
      if (result && result.skipped) {
        await ref.set({
          status: "skipped",
          skippedAt: FieldValue.serverTimestamp(),
          error: result.reason || "skipped"
        }, { merge: true });
        return;
      }

      await ref.set({
        status: "sent",
        sentAt: FieldValue.serverTimestamp(),
        providerMessageId: result?.providerMessageId || null,
        to: FieldValue.delete(),
        email: FieldValue.delete(),
        phone: FieldValue.delete(),
        text: FieldValue.delete(),
        html: FieldValue.delete(),
        error: FieldValue.delete()
      }, { merge: true });
    } catch (error) {
      await ref.set({
        status: "error",
        failedAt: FieldValue.serverTimestamp(),
        error: error && error.message ? error.message : String(error)
      }, { merge: true });
    }
  }
);

exports.smsQueueCreated = onDocumentCreated(
  {
    document: `${SMS_QUEUE_COLLECTION}/{id}`,
    region: "us-central1",
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN]
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const ref = snap.ref;
    const data = snap.data() || {};
    console.info("SMS queue created", {
      id: event.params.id,
      status: data.status || null,
      eventType: data.eventType || null,
      entityId: data.entityId || null,
      phoneLast4: data.phoneLast4 || getPhoneLast4(data.to),
      hasTo: !!data.to,
      hasBody: !!data.body,
      fromLast4: getPhoneLast4(data.from || TWILIO_FROM_NUMBER)
    });
    if (data.status && data.status !== "pending") {
      console.info("SMS queue ignored: not pending", {
        id: event.params.id,
        status: data.status
      });
      return;
    }
    if (!data.to || !data.body) {
      console.warn("SMS queue skipped: missing recipient or body", {
        id: event.params.id,
        hasTo: !!data.to,
        hasBody: !!data.body,
        phoneLast4: data.phoneLast4 || getPhoneLast4(data.to)
      });
      await ref.set({
        status: "skipped",
        skippedAt: FieldValue.serverTimestamp(),
        error: "missing_sms_recipient_or_body",
        to: FieldValue.delete(),
        body: FieldValue.delete()
      }, { merge: true });
      return;
    }

    try {
      const result = await sendSmsViaTwilio(data);
      if (result && result.skipped) {
        console.warn("SMS queue skipped by provider config", {
          id: event.params.id,
          reason: result.reason || "skipped",
          phoneLast4: data.phoneLast4 || getPhoneLast4(data.to)
        });
        await ref.set({
          status: "skipped",
          skippedAt: FieldValue.serverTimestamp(),
          error: result.reason || "skipped",
          to: FieldValue.delete(),
          body: FieldValue.delete()
        }, { merge: true });
        return;
      }

      console.info("SMS sent via Twilio", {
        id: event.params.id,
        providerMessageId: result?.providerMessageId ? "present" : null,
        providerStatus: result?.providerStatus || null,
        phoneLast4: data.phoneLast4 || getPhoneLast4(data.to)
      });
      await ref.set({
        status: "sent",
        sentAt: FieldValue.serverTimestamp(),
        providerMessageId: result?.providerMessageId || null,
        providerStatus: result?.providerStatus || null,
        to: FieldValue.delete(),
        body: FieldValue.delete(),
        error: FieldValue.delete()
      }, { merge: true });
    } catch (error) {
      console.error("SMS queue send failed", {
        id: event.params.id,
        error: error && error.message ? error.message : String(error),
        phoneLast4: data.phoneLast4 || getPhoneLast4(data.to)
      });
      await ref.set({
        status: "error",
        failedAt: FieldValue.serverTimestamp(),
        error: error && error.message ? error.message : String(error),
        to: FieldValue.delete(),
        body: FieldValue.delete()
      }, { merge: true });
    }
  }
);

exports.appointmentStatusEmailUpdated = onDocumentUpdated(
  {
    document: "appointments/{appointmentId}",
    region: "us-central1",
    secrets: [GMAIL_APP_PASSWORD]
  },
  async (event) => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    const appointmentId = event.params.appointmentId;

    if (after.source !== "online_booking") {
      if (before.status !== after.status) {
        console.info("Booking status update ignored: non-online source", {
          appointmentId,
          source: after.source || null,
          beforeStatus: before.status || null,
          afterStatus: after.status || null
        });
      }
      return;
    }
    if (before.status === after.status) return;

    if (after.status === "confirmed" && hasOnlineBookingDeclineHistory(before)) {
      console.info("Booking confirmation notification skipped: appointment was previously declined", {
        appointmentId,
        beforeStatus: before.status || null,
        afterStatus: after.status || null,
        hadDeclinedAt: !!before.declinedAt
      });
      await db.collection(BOOKING_EMAIL_CONTACT_COLLECTION).doc(appointmentId).delete().catch(() => null);
      return;
    }

    const eventType = getBookingStatusEmailEvent(after.status);
    const smsEventType = getBookingStatusSmsEvent(after.status);
    if (!eventType && !smsEventType) return;
    const privateContactSnapshot = after.hasPrivateContact === true
      ? await db.collection(APPOINTMENT_PRIVATE_COLLECTION).doc(appointmentId).get()
      : null;
    const privateContact = privateContactSnapshot?.exists
      ? privateContactSnapshot.data() || {}
      : {};
    const contactAppointment = {
      ...after,
      phone: privateContact.phoneDisplay || privateContact.phoneNormalized || after.phone || null
    };
    console.info("Online booking status changed", {
      appointmentId,
      beforeStatus: before.status || null,
      afterStatus: after.status || null,
      eventType: eventType || null,
      smsEventType: smsEventType || null,
      hasPhone: !!contactAppointment.phone,
      phoneLast4: getPhoneLast4(contactAppointment.phone),
      smsConsent: after.smsConsent !== false
    });
    const staffSnap = await db.collection("staff").get();
    const staffRecords = staffSnap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));

    const writes = [];

    const contactRef = db.collection(BOOKING_EMAIL_CONTACT_COLLECTION).doc(appointmentId);
    const contactSnap = await contactRef.get();
    if (contactSnap.exists) {
      const contact = contactSnap.data() || {};
      const expiresAtMs = contact.expiresAt?.toMillis ? contact.expiresAt.toMillis() : 0;
      if (contact.email && contact.status === "active" && (!expiresAtMs || expiresAtMs > Date.now())) {
        const emailRef = db.collection(EMAIL_QUEUE_COLLECTION).doc();
        writes.push(emailRef.set(buildBookingEmailQueueDoc({
          eventType,
          appointmentId,
          appointmentData: contactAppointment,
          staffRecords,
          email: contact.email
        })));
      }
      writes.push(contactRef.delete().catch(() => null));
    }

    if (smsEventType && after.smsConsent !== false && contactAppointment.phone) {
      const smsRef = db.collection(SMS_QUEUE_COLLECTION).doc();
      writes.push(smsRef.set(buildBookingSmsQueueDoc({
        eventType: smsEventType,
        appointmentId,
        appointmentData: contactAppointment,
        staffRecords
      })));
    } else if (smsEventType) {
      console.warn("SMS queue not created", {
        appointmentId,
        smsEventType,
        reason: !contactAppointment.phone ? "missing_phone" : "sms_consent_false",
        hasPhone: !!contactAppointment.phone,
        phoneLast4: getPhoneLast4(contactAppointment.phone),
        smsConsent: after.smsConsent !== false
      });
    }

    await Promise.all(writes);
  }
);

exports.appointmentPhotoRetentionUpdated = onDocumentUpdated(
  {
    document: "appointments/{appointmentId}",
    region: "us-central1"
  },
  async (event) => {
    const before = event.data?.before?.data() || {};
    const after = event.data?.after?.data() || {};
    if (after.source !== "online_booking" || before.status === after.status) return;
    const isClientCancellation = after.status === "cancelled" && after.canceled === true;
    if (!["confirmed", "declined"].includes(after.status) && !isClientCancellation) return;
    if (!after.photoReviewToken) return;

    const deadlineMs = getPhotoRetentionDeadlineMs(after, PHOTO_TTL_MS);
    if (!deadlineMs) return;

    const retentionStartedAt = after.status === "confirmed"
      ? after.confirmedAt
      : (after.status === "declined" ? after.declinedAt : after.canceledAt);

    await db.collection(PHOTO_COLLECTION).doc(after.photoReviewToken).set({
      retentionState: "decision_made",
      retentionPolicyVersion: 3,
      decisionStatus: after.status,
      retentionStartedAt: retentionStartedAt || FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(deadlineMs)
    }, { merge: true });
  }
);

exports.twilioIncomingSms = onRequest(
  {
    region: "us-central1",
    secrets: [TWILIO_AUTH_TOKEN]
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    if (!validateTwilioSignature(req)) {
      console.warn("Twilio SMS signature did not validate; accepting webhook for delivery.", {
        host: req.get("host"),
        url: req.originalUrl
      });
    }

    try {
      if (!TELEGRAM_NOTIFICATIONS_PAUSED) {
        const from = readTwilioParam(req, "From");
        const to = readTwilioParam(req, "To");
        const body = readTwilioParam(req, "Body");
        const message = buildIncomingSmsTelegramMessage({ from, to, body });

        await db.collection("TelegramQueue").add({
          status: "pending",
          message,
          eventType: "twilio_incoming_sms",
          entityType: "twilio_sms",
          phoneLast4: getPhoneLast4(from),
          twilioToLast4: getPhoneLast4(to),
          createdAt: FieldValue.serverTimestamp(),
          source: "twilio"
        });
      }
      res.status(200).type("text/xml").send("<Response></Response>");
    } catch (error) {
      console.error("Twilio incoming SMS webhook error:", error);
      res.status(500).send("Internal error");
    }
  }
);

exports.twilioIncomingCall = onRequest(
  {
    region: "us-central1",
    secrets: [TWILIO_AUTH_TOKEN]
  },
  async (req, res) => {
    if (req.method !== "POST" && req.method !== "GET") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    if (req.method === "POST" && !validateTwilioSignature(req)) {
      console.warn("Twilio call signature did not validate; accepting webhook for forwarding.", {
        host: req.get("host"),
        url: req.originalUrl
      });
    }

    res.status(200).type("text/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${SALON_PHONE_E164}</Dial></Response>`
    );
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
        throw new HttpsError("failed-precondition", "This photo link is no longer available.");
      }

      files = data.files || [];
      tx.set(ref, {
        lastViewedAt: FieldValue.serverTimestamp(),
        viewCount: FieldValue.increment(1)
      }, { merge: true });
    });

    let photos = [];
    try {
      photos = await readPhotoReviewFiles(files);
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
      message: "Photos are available until this temporary link expires."
    };
  }
);

exports.cleanupExpiredOnlineBookingPrivateData = onSchedule(
  {
    region: "us-central1",
    schedule: "every 1 hours",
    timeZone: "America/Edmonton"
  },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const expiredContacts = await db.collection(BOOKING_EMAIL_CONTACT_COLLECTION)
      .where("expiresAt", "<=", now)
      .limit(100)
      .get();

    const emailQueueCutoff = admin.firestore.Timestamp.fromDate(new Date(Date.now() - BOOKING_EMAIL_TTL_MS));
    const oldEmailQueue = await db.collection(EMAIL_QUEUE_COLLECTION)
      .where("createdAt", "<=", emailQueueCutoff)
      .limit(100)
      .get();

    const legacyEmailCollections = ["appointments", "activityLog", "onlineBookingSubmissions"];
    const legacyEmailSnaps = await Promise.all(
      legacyEmailCollections.map(collectionName => db.collection(collectionName)
        .where("email", "!=", null)
        .limit(100)
        .get())
    );

    const legacyEmailUpdates = legacyEmailSnaps.flatMap(snap => snap.docs.map(docSnap => docSnap.ref.set({
      email: FieldValue.delete(),
      emailProvided: true,
      emailPurgedAt: FieldValue.serverTimestamp()
    }, { merge: true })));

    await Promise.all([
      ...expiredContacts.docs.map(docSnap => docSnap.ref.delete()),
      ...oldEmailQueue.docs.map(docSnap => docSnap.ref.delete()),
      ...legacyEmailUpdates
    ]);
  }
);
exports.registerPushDevice = onCall(
  {
    region: "us-central1",
    maxInstances: 10
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const token = String(request.data?.token || "").trim();
    if (!token || token.length < 20) {
      throw new HttpsError("invalid-argument", "Missing push token.");
    }

    const userProfileSnap = await db.collection("users").doc(request.auth.uid).get();
    if (!userProfileSnap.exists) {
      throw new HttpsError("permission-denied", "User profile not found.");
    }
    const userProfile = userProfileSnap.data() || {};
    const role = String(userProfile.role || "").trim();
    const staffId = String(userProfile.staffId || "").trim();
    if (!["manager", "staff"].includes(role)) {
      throw new HttpsError("permission-denied", "This account cannot register message notifications.");
    }
    const userAgent = String(request.data?.userAgent || "").slice(0, 500);
    const rawDeviceId = String(request.data?.deviceId || "").trim();
    const safeDeviceId = rawDeviceId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const deviceDocId = safeDeviceId
      ? `${request.auth.uid}_${safeDeviceId}`
      : `${request.auth.uid}_${tokenHash.slice(0, 24)}`;
    const deviceRef = db.collection("staffPushDevices").doc(deviceDocId);

    const replacementQueries = [
      db.collection("staffPushDevices")
        .where("uid", "==", request.auth.uid)
        .where("enabled", "==", true)
        .get(),
      db.collection("staffPushDevices")
        .where("tokenHash", "==", tokenHash)
        .get()
    ];
    if (safeDeviceId) {
      replacementQueries.push(
        db.collection("staffPushDevices")
          .where("deviceId", "==", safeDeviceId)
          .get()
      );
    }

    const replacementSnaps = await Promise.all(replacementQueries);
    const oldDeviceDocs = new Map();
    replacementSnaps.forEach(querySnap => {
      querySnap.docs.forEach(docSnap => {
        const device = docSnap.data() || {};
        if (docSnap.id !== deviceDocId && device.enabled === true) oldDeviceDocs.set(docSnap.id, docSnap);
      });
    });

    const disableOldWrites = Array.from(oldDeviceDocs.values()).map(docSnap => docSnap.ref.set({
      enabled: false,
      disabledAt: FieldValue.serverTimestamp(),
      disabledReason: "replaced_by_current_device"
    }, { merge: true }));

    await Promise.all(disableOldWrites);

    await deviceRef.set({
      uid: request.auth.uid,
      token,
      tokenHash,
      deviceId: safeDeviceId || "",
      role,
      staffId,
      enabled: true,
      userAgent,
      updatedAt: FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + PUSH_DEVICE_TTL_MS))
    }, { merge: true });

    return { ok: true };
  }
);

exports.getStaffPushStatuses = onCall(
  { region: "us-central1", maxInstances: 10, invoker: "public" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");
    const callerSnap = await db.collection("users").doc(request.auth.uid).get();
    if (!callerSnap.exists || callerSnap.data()?.role !== "manager") {
      throw new HttpsError("permission-denied", "Only a manager can view notification status.");
    }
    const devicesSnap = await db.collection("staffPushDevices").where("enabled", "==", true).get();
    const byStaffId = {};
    devicesSnap.docs.forEach(docSnap => {
      const device = docSnap.data() || {};
      if (!device.staffId || device.role !== "staff") return;
      const current = byStaffId[device.staffId] || { enabledDevices: 0, lastConnectedAt: null, userAgent: "" };
      current.enabledDevices += 1;
      const updatedMs = device.updatedAt?.toMillis ? device.updatedAt.toMillis() : 0;
      const currentMs = current.lastConnectedAt || 0;
      if (updatedMs >= currentMs) {
        current.lastConnectedAt = updatedMs;
        current.userAgent = String(device.userAgent || "").slice(0, 300);
      }
      byStaffId[device.staffId] = current;
    });
    return { statuses: byStaffId };
  }
);

async function handleStaffMessageCreated(event) {
    const snap = event.data;
    if (!snap) return;

    const data = snap.data() || {};
    if (!shouldProcessStaffPush(data)) {
      return;
    }

    const deviceSnaps = [];
    if (data.audienceVersion === 2) {
      const allDevicesSnap = await db.collection("staffPushDevices")
        .where("enabled", "==", true)
        .get();
      const importantStaffIds = new Set(Array.isArray(data.importantStaffIds) ? data.importantStaffIds : []);
      const managerShouldReceive = data.visibleToManager !== false && ["key", "message"].includes(data.managerPriority);
      allDevicesSnap.docs.forEach(docSnap => {
        const device = docSnap.data() || {};
        if (device.role === "manager" && managerShouldReceive) deviceSnaps.push(docSnap);
        if (device.role === "staff" && (data.pushToAllStaff === true || importantStaffIds.has(device.staffId))) {
          deviceSnaps.push(docSnap);
        }
      });
    } else if (["key", "message"].includes(data.priority) && data.visibleToManager !== false) {
      const managerSnap = await db.collection("staffPushDevices")
        .where("enabled", "==", true)
        .where("role", "==", "manager")
        .get();
      deviceSnaps.push(...managerSnap.docs);
    } else if (!["key", "message"].includes(data.priority)) {
      return;
    }

    if (data.audienceVersion !== 2 && data.recipientStaffId) {
      const staffSnap = await db.collection("staffPushDevices")
        .where("enabled", "==", true)
        .where("staffId", "==", data.recipientStaffId)
        .get();
      deviceSnaps.push(...staffSnap.docs);
    }

    const latestDeviceByKey = new Map();
    for (const docSnap of deviceSnaps) {
      const device = docSnap.data() || {};
      if (!device.token) continue;
      if (data.senderUid && device.uid === data.senderUid) continue;
      if (data.senderStaffId && device.role === "staff" && device.staffId === data.senderStaffId) continue;
      const deviceKey = device.deviceId
        ? `${device.uid || ""}:${device.deviceId}`
        : `${device.uid || ""}:${device.userAgent || ""}`;
      const updatedMs = device.updatedAt?.toMillis ? device.updatedAt.toMillis() : 0;
      const existing = latestDeviceByKey.get(deviceKey);
      if (!existing || updatedMs >= existing.updatedMs) {
        latestDeviceByKey.set(deviceKey, { token: device.token, ref: docSnap.ref, updatedMs });
      }
    }

    const tokenMap = new Map();
    for (const device of latestDeviceByKey.values()) {
      tokenMap.set(device.token, device.ref);
    }
    const tokens = Array.from(tokenMap.keys()).slice(0, 500);
    if (!tokens.length) {
      await snap.ref.set({
        pushStatus: "skipped",
        pushSkippedReason: "no_devices",
        pushCheckedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return;
    }

    const title = data.title || "Calendar message";
    const senderPrefix = data.senderLabel ? String(data.senderLabel).slice(0, 60) + ": " : "";
    const body = (senderPrefix + String(data.body || "")).slice(0, 180);
    const requestedLink = String(data.notificationLink || "");
    const notificationLink = /^https:\/\/[a-z0-9-]+\.web\.app$/i.test(requestedLink)
      ? requestedLink
      : "https://rosesnails-calendar.web.app";

    const result = await admin.messaging().sendEachForMulticast({
      tokens,
      webpush: {
        fcmOptions: {
          link: notificationLink
        }
      },
      data: {
        notificationId: event.params.id,
        appointmentId: data.entityType === "appointment" ? String(data.entityId || "") : "",
        eventType: String(data.eventType || ""),
        title,
        body,
        senderUid: String(data.senderUid || ""),
        senderStaffId: String(data.senderStaffId || "")
      }
    });

    const invalidTokenCodes = new Set([
      "messaging/invalid-registration-token",
      "messaging/registration-token-not-registered"
    ]);
    await Promise.all(result.responses.map((response, index) => {
      if (response.success) return null;
      const code = response.error?.code || "";
      if (invalidTokenCodes.has(code)) {
        return tokenMap.get(tokens[index])?.set({
          enabled: false,
          disabledAt: FieldValue.serverTimestamp(),
          disabledReason: code
        }, { merge: true });
      }
      return null;
    }));

    await snap.ref.set({
      pushStatus: "sent",
      pushSuccessCount: result.successCount,
      pushFailureCount: result.failureCount,
      pushSentAt: FieldValue.serverTimestamp()
    }, { merge: true });
}

exports.staffNotificationCreated = onDocumentCreated(
  {
    document: "staffNotifications/{id}",
    region: "us-central1",
    maxInstances: 10
  },
  handleStaffMessageCreated
);

exports.staffMessageCreated = onDocumentCreated(
  {
    document: "staffMessages/{id}",
    region: "us-central1",
    maxInstances: 10
  },
  handleStaffMessageCreated
);

exports.cleanupExpiredStaffNotifications = onSchedule(
  {
    region: "us-central1",
    schedule: "every 24 hours",
    timeZone: "America/Edmonton"
  },
  async () => {
    const snap = await db.collection("staffNotifications")
      .where("expiresAt", "<=", admin.firestore.Timestamp.now())
      .limit(200)
      .get();
    const canonicalSnap = await db.collection("staffMessages")
      .where("expiresAt", "<=", admin.firestore.Timestamp.now())
      .limit(200)
      .get();

    const expiredDevices = await db.collection("staffPushDevices")
      .where("expiresAt", "<=", admin.firestore.Timestamp.now())
      .limit(200)
      .get();

    await Promise.all([
      ...snap.docs.map(docSnap => docSnap.ref.delete()),
      ...canonicalSnap.docs.map(docSnap => docSnap.ref.delete()),
      ...expiredDevices.docs.map(docSnap => docSnap.ref.delete())
    ]);
  }
);

exports.cleanupExpiredOnlineBookingVerificationData = onSchedule(
  {
    region: "us-central1",
    schedule: "every 6 hours",
    timeZone: "America/Edmonton"
  },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const [challengeSnap, rateSnap] = await Promise.all([
      db.collection(BOOKING_VERIFICATION_COLLECTION)
        .where("cleanupAt", "<=", now)
        .limit(250)
        .get(),
      db.collection(BOOKING_VERIFICATION_RATE_COLLECTION)
        .where("cleanupAt", "<=", now)
        .limit(250)
        .get()
    ]);

    await Promise.all([
      ...challengeSnap.docs.map(docSnap => docSnap.ref.delete()),
      ...rateSnap.docs.map(docSnap => docSnap.ref.delete())
    ]);
  }
);

exports.cleanupExpiredOnlineBookingPhotos = onSchedule(
  {
    region: "us-central1",
    schedule: "every 1 hours",
    timeZone: "America/Edmonton"
  },
  async () => {
    const nowMs = Date.now();
    const snap = await db.collection(PHOTO_COLLECTION)
      .where("expiresAt", "<=", admin.firestore.Timestamp.now())
      .limit(50)
      .get();

    await Promise.all(snap.docs.map(async docSnap => {
      const data = docSnap.data() || {};
      if (data.status === "active" || data.status === "error") {
        let appointment = null;
        if (data.appointmentId) {
          const appointmentSnap = await db.collection("appointments").doc(data.appointmentId).get();
          appointment = appointmentSnap.exists ? appointmentSnap.data() || {} : null;
        }

        if (appointment && isPendingOnlineRequest(appointment)) {
          await docSnap.ref.set({
            retentionState: "pending_appointment_decision",
            retentionPolicyVersion: 3,
            expiresAt: FieldValue.delete(),
            retentionDeferredAt: FieldValue.serverTimestamp()
          }, { merge: true });
          return;
        }

        const existingDeadlineMs = data.expiresAt?.toMillis ? data.expiresAt.toMillis() : 0;
        const fallbackDecisionMs = data.retentionPolicyVersion === 3 && existingDeadlineMs
          ? existingDeadlineMs - PHOTO_TTL_MS
          : nowMs;
        const decisionDeadlineMs = getPhotoRetentionDeadlineMs(
          appointment,
          PHOTO_TTL_MS,
          fallbackDecisionMs
        );
        if (decisionDeadlineMs && decisionDeadlineMs > nowMs) {
          const retentionStartedAt = appointment.status === "confirmed"
            ? appointment.confirmedAt
            : (appointment.status === "declined" ? appointment.declinedAt : appointment.canceledAt);
          await docSnap.ref.set({
            retentionState: "decision_made",
            retentionPolicyVersion: 3,
            decisionStatus: appointment.status,
            retentionStartedAt: retentionStartedAt || FieldValue.serverTimestamp(),
            expiresAt: admin.firestore.Timestamp.fromMillis(decisionDeadlineMs)
          }, { merge: true });
          return;
        }

        await deletePhotoFiles(data.files || []);
        await docSnap.ref.set({
          status: "expired",
          retentionState: "expired",
          retentionPolicyVersion: 3,
          filesDeletedAt: FieldValue.serverTimestamp(),
          expiredAt: FieldValue.serverTimestamp()
        }, { merge: true });

        if (data.appointmentId) {
          await db.collection("appointments").doc(data.appointmentId).set({
            photoRefs: FieldValue.delete(),
            photoLinks: FieldValue.delete(),
            photoReviewToken: FieldValue.delete(),
            photoReviewUrl: FieldValue.delete(),
            photosExpiredAt: FieldValue.serverTimestamp()
          }, { merge: true });
        }
      }
    }));
  }
);

exports.getOnlineBookingAvailability = onCall(
  {
    region: "us-central1",
    maxInstances: 5,
    secrets: [CLIENT_LOOKUP_PEPPER]
  },
  async (request) => {
    const input = request.data || {};
    const date = assertDate(input.date);
    const requestedGroups = getRequestedServiceGroups(input);

    const requestedDate = getLocalDate(date);
    if (Number.isNaN(requestedDate.getTime())) {
      throw new HttpsError("invalid-argument", "Invalid date.");
    }

    const clientContextPromise = normalizePhone(input.phone) && normalizeClientName(input.client)
      ? readClientContext({
          db,
          pepper: getClientLookupPepper(),
          phone: input.phone,
          clientName: input.client,
          allowCloseNameMatch: true
        })
      : Promise.resolve(null);

    const [staffSnap, appointmentsSnap, offWorkSnap, weeklyOffSnap, clientContext] = await Promise.all([
      db.collection("staff").get(),
      db.collection("appointments").where("date", "==", date).get(),
      db.collection("OffWork").where("date", "==", date).get(),
      db.collection("WeeklyOff").get(),
      clientContextPromise
    ]);

    const staffRecords = getActiveStaffRecords(staffSnap.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data()
    })));
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
      durationInput: {
        selectedServices: Array.isArray(input.selectedServices) ? input.selectedServices : [],
        serviceDetails: input.serviceDetails || ""
      },
      appointments,
      staffRecords,
      offWorkRecords,
      weeklyOffRecords,
      clientSummary: clientContext?.summary || null
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

    if (isNewUser && !TELEGRAM_NOTIFICATIONS_PAUSED) {
 const telegramText =
  `Hello ${staffName}, welcome to Rose's Nails Calendar.\n\n` +
  `Your login is ready now.\n\n` +
  `Please use Forgot Password on the login screen.\n` +
  `If you do not see the email, please check your Spam/Junk folder.`;
      try {
        await sendTelegram(telegramText);
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
