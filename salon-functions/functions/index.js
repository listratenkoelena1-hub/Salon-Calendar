const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } =
require("firebase-functions/v2/firestore");
const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");

const admin = require("firebase-admin");
const fetch = require("node-fetch");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

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
const STAFF_BOOKING_DURATION_DEFAULT_SLOTS = 4;
const STAFF_BOOKING_DURATION_KEYS = [
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
];
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
const SALON_PHONE_E164 = "+17804066767";
const SALON_PHONE_DISPLAY = "+1 780-406-6767";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "+15876060462";
const BOOKING_EMAIL_CONTACT_COLLECTION = "onlineBookingEmailContacts";
const BOOKING_EMAIL_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const PRIVACY_CONSENT_VERSION = "privacy-consent-v2-2026-07-20";
const EMAIL_DEFAULT_FROM_NAME = "Rose's Nails";
const EMAIL_DEFAULT_FROM_EMAIL = "booking@rosesnailslondonderry.ca";
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || "gmailTest";
const EMAIL_TEST_GMAIL_USER = "rosesnails13721@gmail.com";
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || EMAIL_DEFAULT_FROM_NAME;
const EMAIL_FROM_EMAIL = process.env.EMAIL_FROM_EMAIL || (EMAIL_PROVIDER === "gmailTest" ? EMAIL_TEST_GMAIL_USER : EMAIL_DEFAULT_FROM_EMAIL);
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");

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
  phone: appointmentData.phone || null,
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

  if (/brow|eyebrow|tint/.test(normalized)) groups.push("brows");
  if (/lash|eyelash/.test(normalized)) groups.push("lashes");
  if (/wax|waxing/.test(normalized) && !/brow|eyebrow/.test(normalized)) groups.push("waxing");
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

function normalizeDurationSlots(value, fallback = STAFF_BOOKING_DURATION_DEFAULT_SLOTS) {
  const slots = Number(value);
  if (!Number.isFinite(slots) || slots <= 0) return fallback;
  return Math.max(1, Math.min(24, Math.ceil(slots)));
}

function getStaffBookingDuration(staffRecord, key, fallback = STAFF_BOOKING_DURATION_DEFAULT_SLOTS) {
  const durations = staffRecord?.bookingDurations && typeof staffRecord.bookingDurations === "object"
    ? staffRecord.bookingDurations
    : {};
  if (!STAFF_BOOKING_DURATION_KEYS.includes(key)) return fallback;
  return normalizeDurationSlots(durations[key], fallback);
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

function getSegmentZones(text) {
  const zones = [];
  const hasFeet = textMatches(text, [/\bpedicure\b/, /\bpedi\b/, /\btoe(s)?\b/, /\btoenail(s)?\b/]);
  const hasHands = textMatches(text, [/\bmanicure\b/, /\bmani\b/, /\bfingernail(s)?\b/]);

  if (hasHands) zones.push("hands");
  if (hasFeet) zones.push("feet");
  return zones;
}

function addDurationZone(zoneSet, zone) {
  if (zone) zoneSet.add(zone);
}

function getRequestedBookingDurationSlots(input = {}, staffRecord = {}) {
  const requestedGroups = input.requestedGroups || getRequestedServiceGroups(input);
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
    const hasHandsZone = zones.includes("hands");
    const hasFeetZone = zones.includes("feet");
    const defaultNailZone = hasFeetZone ? "feet" : "hands";

    const hasGel = textMatches(segment, [/\bgel\b/, /\bshellac\b/, /\bgel\s*polish\b/]);
    const hasDeluxe = textMatches(segment, [/\bdeluxe\b/]);
    const hasNoColor = textMatches(segment, [/\bno\s*colou?r\b/, /\bno\s*polish\b/, /\bwithout\s*colou?r\b/, /\bcleaning\s*only\b/]);
    const hasChangeColor = textMatches(segment, [/\bchange\s*colou?r\b/, /\bpolish\s*change\b/, /\bcolour\s*change\b/, /\bapply\s*gel\s*polish\b/]);
    const hasRefill = textMatches(segment, [/\brefill\b/, /\bfill\b/]);
    const hasExtensions = textMatches(segment, [/\bextension(s)?\b/, /\bnew\s*set\b/, /\bfull\s*set\b/]);
    const hasGelOverlay = textMatches(segment, [/\bgel\s*overlay\b/, /\boverlay\b/, /\bbuilder\s*gel\b/, /\bhard\s*gel\b/]);
    const hasOneNailExtension = textMatches(segment, [/\bone\s*nail\s*extension\b/]);
    const hasManicure = hasHandsZone || textMatches(segment, [/\bmanicure\b/, /\bmani\b/]);
    const hasPedicure = hasFeetZone || textMatches(segment, [/\bpedicure\b/, /\bpedi\b/]);
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
      if (hasGel && !hasNoColor) {
        handsMain = Math.max(handsMain, getStaffBookingDuration(staffRecord, "manicureGelPolish"));
        feetMain = Math.max(feetMain, getStaffBookingDuration(staffRecord, "pedicureGelPolish"));
      } else {
        handsMain = Math.max(handsMain, getStaffBookingDuration(staffRecord, "manicureNoColor"));
        feetMain = Math.max(feetMain, getStaffBookingDuration(staffRecord, hasDeluxe && !hasNoColor ? "pedicureGelPolish" : "pedicureNoColor"));
      }
    } else if (!isStandaloneRemoving && hasFeetZone) {
      if (hasExtensions || hasRefill) {
        feetMain = Math.max(feetMain, BOOKING_DURATION);
      }
      if (hasChangeColor) {
        feetMain = Math.max(feetMain, getStaffBookingDuration(staffRecord, "pedicureChangeColor"));
      }
      if (hasPedicure) {
        feetMain = Math.max(
          feetMain,
          getStaffBookingDuration(staffRecord, (hasGel || hasDeluxe) && !hasNoColor ? "pedicureGelPolish" : "pedicureNoColor")
        );
      }
    } else if (!isStandaloneRemoving && (hasHandsZone || hasRefill || hasExtensions || hasGelOverlay || hasChangeColor || textMatches(segment, [/\bnail(s)?\b/]))) {
      if (hasRefill) {
        handsMain = Math.max(handsMain, getStaffBookingDuration(staffRecord, "refillNoDesign"));
      }
      if (hasExtensions && !hasOneNailExtension) {
        handsMain = Math.max(handsMain, getStaffBookingDuration(staffRecord, "extensionsNoDesign"));
      }
      if (hasGelOverlay) {
        handsMain = Math.max(handsMain, BOOKING_DURATION);
      }
      if (hasChangeColor) {
        handsMain = Math.max(handsMain, getStaffBookingDuration(staffRecord, "changeColor"));
      }
      if (hasManicure) {
        handsMain = Math.max(
          handsMain,
          getStaffBookingDuration(staffRecord, hasGel && !hasNoColor ? "manicureGelPolish" : "manicureNoColor")
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

    const hasDesign = !hasFrench && textMatches(segment, [/\bdesign\b/, /\bnail\s*art\b/, /\bart\b/, /\bombre\b/, /\bchrome\b/, /\bcat\s*eye\b/, /\bglitter\b/, /\bfloral\b/]);
    if (hasDesign) {
      if (hasHandsZone) addDurationZone(designZones, "hands");
      else if (hasFeetZone) addDurationZone(designZones, "feet");
      else addDurationZone(designZones, defaultNailZone);
    }

    if (hasOneNailExtension) hasOneNailExtensionOnly = true;
    if (textMatches(segment, [/\bparaffin\b/])) otherAddOns += 1;
    if (textMatches(segment, [/\bcut\s*nails?\b/, /\bcut\s*toe\s*nails?\b/, /\bnail\s*trim\b/, /\btoenail\s*trim\b/])) otherAddOns += 1;
    if (textMatches(segment, [/\bchange\s*nails?\s*shape\b/, /\breshape\b/])) otherAddOns += 1;
  });

  let total = handsMain + feetMain + removingAddOn + otherAddOns;

  if (hasOneNailExtensionOnly && handsMain === 0) total += 1;

  const frenchCount = Math.max(0, frenchZones.size);
  if (frenchCount) {
    total += frenchCount;
  }

  total += designZones.size;

  return total > 0 ? Math.max(1, Math.min(24, total)) : BOOKING_DURATION;
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
    .filter(s => s.availableForAnyone !== false)
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
  durationInput = {},
  appointments,
  staffRecords,
  offWorkRecords,
  weeklyOffRecords
}) {
  const hours = getSalonBookingHours(date);
  const minBookableSlot = Math.max(hours.start, getMinimumBookableSlot(date));
  const maxBookableStartSlot = Math.min(BOOKING_LATEST_START_SLOT, hours.end - 1);
  const realStaff = staffRecords
    .filter(s => s.id && s.id !== ANYONE_ID)
    .filter(s => s.bookingEnabled !== false)
    .map(s => {
      const requestedDuration = getRequestedBookingDurationSlots({
        ...durationInput,
        requestedGroups
      }, s);
      return {
        id: s.id,
        name: s.name || "Staff",
        availableForAnyone: s.availableForAnyone !== false,
        serviceGroups: getStaffServiceGroups(s),
        canDoRequestedServices: staffCanDoServiceGroups(s, requestedGroups),
        requestedDuration
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
          staffRecords: realStaff,
          offWorkRecords,
          weeklyOffRecords,
          requestedGroups
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
    staff: realStaff,
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
  const expiresAtDate = new Date(Date.now() + PHOTO_TTL_MS);
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
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAtDate)
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
    const consentVersion = String(input.consentVersion || PRIVACY_CONSENT_VERSION).trim();

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

    if (!isBookableOnlineStart({ date, start, duration: 1 })) {
      throw new HttpsError("failed-precondition", "Please choose an available time at least 1 hour ahead.");
    }

    const submissionRef = db.collection("onlineBookingSubmissions").doc(requestId);
    const appointmentRef = db.collection("appointments").doc();
    const logRef = db.collection("activityLog").doc();
    const telegramRef = db.collection("TelegramQueue").doc();
    const staffNotificationRef = db.collection("staffNotifications").doc();
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

      let duration = BOOKING_DURATION;
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
          requestedGroups
        });

        if (remainingCapacity <= 0) {
          throw new HttpsError("failed-precondition", "This time is no longer available.");
        }
      } else {
        duration = getRequestedBookingDurationSlots({
          selectedServices,
          serviceDetails,
          requestedGroups
        }, selectedStaff);
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
      }

      const appointmentData = {
        date,
        staffId,
        phone,
        emailProvided: Boolean(email),
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
        consentVersion,
        consentSource: "online_booking",
        consentPurpose: "appointment_related_contact_only",
        phoneContactConsent: true,
        smsConsent: true,
        marketingConsent: false,
        consentAcceptedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        lastEditedBy: "Online Booking",
        lastAction: "online_request_created",
        lastActionAt: FieldValue.serverTimestamp()
      };

      tx.set(appointmentRef, appointmentData);
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
        client,
        phone,
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
          appointmentData,
          staffRecords,
          email
        }));
      }

      const onlineBookingTelegramMessage = buildOnlineBookingTelegramMessage(appointmentData, staffRecords);
      const messageGroupId = `online-booking-${appointmentRef.id}`;
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

      tx.set(staffNotificationRef, buildStaffNotificationDoc({
        message: onlineBookingTelegramMessage,
        eventType: "online_request_created",
        entityType: "appointment",
        entityId: appointmentRef.id,
        staffId,
        staffName: getStaffName(staffRecords, staffId),
        photoReviewUrl: appointmentData.photoReviewUrl || "",
        source: "online_booking",
        messageGroupId
      }));

      // During the test rollout, keep the legacy document for the production
      // calendar and add one canonical document for the new test client.
      tx.set(staffMessageRef, {
        ...buildCanonicalStaffMessageDoc({
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
        }),
        pushEligible: false
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
    console.info("Online booking status changed", {
      appointmentId,
      beforeStatus: before.status || null,
      afterStatus: after.status || null,
      eventType: eventType || null,
      smsEventType: smsEventType || null,
      hasPhone: !!after.phone,
      phoneLast4: getPhoneLast4(after.phone),
      smsConsent: after.smsConsent !== false
    });
    if (!eventType && !smsEventType) return;

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
          appointmentData: after,
          staffRecords,
          email: contact.email
        })));
      }
      writes.push(contactRef.delete().catch(() => null));
    }

    if (smsEventType && after.smsConsent !== false && after.phone) {
      const smsRef = db.collection(SMS_QUEUE_COLLECTION).doc();
      writes.push(smsRef.set(buildBookingSmsQueueDoc({
        eventType: smsEventType,
        appointmentId,
        appointmentData: after,
        staffRecords
      })));
    } else if (smsEventType) {
      console.warn("SMS queue not created", {
        appointmentId,
        smsEventType,
        reason: !after.phone ? "missing_phone" : "sms_consent_false",
        hasPhone: !!after.phone,
        phoneLast4: getPhoneLast4(after.phone),
        smsConsent: after.smsConsent !== false
      });
    }

    await Promise.all(writes);
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

    const from = readTwilioParam(req, "From");
    const to = readTwilioParam(req, "To");
    const body = readTwilioParam(req, "Body");
    const message = buildIncomingSmsTelegramMessage({ from, to, body });

    try {
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
    if (data.pushEligible !== true) {
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
      if (data.status === "active" || data.status === "error") {
        await deletePhotoFiles(data.files || []);
        await docSnap.ref.set({
          status: "expired",
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















