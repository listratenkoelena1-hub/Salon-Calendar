const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } =
require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

/* === НАСТРОЙКИ TELEGRAM === */
const BOT_TOKEN = "8570779845:AAHbb2LI4judUopNFDiMN3-gXmLzusRe9JE";

// ===== TELEGRAM MODE =====
// test → сообщения идут только тебе
// prod → сообщения идут в общий чат салона
const TELEGRAM_MODE = "prod";

const TELEGRAM_CHAT_PROD = "-1003851620923"; // общий чат салона
const TELEGRAM_CHAT_TEST = "1864541569";     // твой личный Telegram ID

const CHAT_ID =
  TELEGRAM_MODE === "test"
    ? TELEGRAM_CHAT_TEST
    : TELEGRAM_CHAT_PROD;

/* === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ === */

// слот → время (с 08:00, шаг 15 мин)
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

// длительность в HH:MM или прочерк для Anyone
function formatDuration(slots, staffName) {
if (staffName === "Anyone") return "—";
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

// дата без года: Friday, January 23
function formatDate(dateStr) {
const date = new Date(dateStr);
return date.toLocaleDateString("en-US", {
weekday: "long",
day: "numeric",
month: "long",
});
}

// отправка в Telegram
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

function buildMessage(type, data, staffName, changedText = "") {

const firstLine = `${type} for <b>${staffName}</b> — ${formatDate(data.date)} at ${slotToTime(data.start)}.`;

let secondLine = "";

if (type === "New appointment") {

  if (data.note && data.note.trim()) {
    secondLine = `${data.client || "Client"} is coming for ${data.note.trim()}. Duration: ${formatDuration(data.duration, staffName)}.`;
  } else {
    secondLine = `${data.client || "Client"} is booked. Duration: ${formatDuration(data.duration, staffName)}.`;
  }

}

if (type === "Appointment") {
  secondLine = changedText ? `Changed: ${changedText}.` : "";
}

const editorLine = data.lastEditedBy ? `@${data.lastEditedBy}` : "";

const lines = [firstLine];

if (secondLine) lines.push(secondLine);
if (editorLine) lines.push(editorLine);

return lines.join("\n");

}
/* === FIRESTORE TRIGGERS (GEN 2) === */

// CREATE
exports.appointmentCreated = onDocumentCreated(
"appointments/{id}",
async (event) => {
const data = event.data.data();

const staffDoc = await admin
  .firestore()
  .doc(`staff/${data.staffId}`)
  .get();

const staffName = staffDoc.exists
  ? staffDoc.data().name
  : "Anyone";

await sendTelegram(
  buildMessage("New appointment", data, staffName)
);
}
);
// UPDATE
exports.appointmentUpdated = onDocumentUpdated(
"appointments/{id}",
async (event) => {
const before = event.data.before.data();
const after = event.data.after.data();

const staffDoc = await admin
  .firestore()
  .doc(`staff/${after.staffId}`)
  .get();

const staffName = staffDoc.exists
  ? staffDoc.data().name
  : "Anyone";

const editorLine = after.lastEditedBy ? `\n@${after.lastEditedBy}` : "";
const clientName = after.client || "Client";

// MOVE TO OTHER DATE
if (after.lastAction === "move") {
  await sendTelegram(
    `Appointment for ${clientName} with <b>${staffName}</b> was moved.\nNew time: ${formatDate(after.date)} at ${slotToTime(after.start)}.${editorLine}`
  );
  return;
}

// CANCELED
if (after.lastAction === "cancel") {
  const commentText =
    after.cancelComment && after.cancelComment.trim()
      ? ` ${after.cancelComment.trim()}`
      : "";

  await sendTelegram(
    `Appointment for ${clientName} with <b>${staffName}</b> was canceled.${commentText}${editorLine}`
  );
  return;
}

// CANCELED REMOVED
if (after.lastAction === "cancel_removed") {
  await sendTelegram(
    `Cancellation was removed for ${clientName}'s appointment with ${staffName}.${editorLine}`
  );
  return;
}

// NO-SHOW
if (after.lastAction === "no_show") {
  await sendTelegram(
    `${clientName} did not show up for the appointment with <b>${staffName}</b>. The time is available now.${editorLine}`
  );
  return;
}

// NO-SHOW REMOVED
if (after.lastAction === "no_show_removed") {
  await sendTelegram(
    `No-show was removed for ${clientName}'s appointment with ${staffName}.${editorLine}`
  );
  return;
}

// REGULAR UPDATE
const changes = [];

if (before.start !== after.start) {
  changes.push(`time to ${slotToTime(after.start)}`);
}

if (before.duration !== after.duration) {
  changes.push(`duration to ${formatDuration(after.duration, staffName)}`);
}

if ((before.client || "") !== (after.client || "")) {
  changes.push(`client to ${after.client || "-"}`);
}

if ((before.note || "") !== (after.note || "")) {
  changes.push(`service to ${after.note || "-"}`);
}

if (changes.length === 0) return;

await sendTelegram(
  `Appointment for <b>${staffName}</b> — ${formatDate(after.date)} at ${slotToTime(after.start)} was updated.\nChanged: ${changes.join(", ")}.${editorLine}`
);
}
);
// DELETE
exports.appointmentDeleted = onDocumentDeleted(
"appointments/{id}",
async (event) => {
const data = event.data.data();

const staffDoc = await admin
  .firestore()
  .doc(`staff/${data.staffId}`)
  .get();

const staffName = staffDoc.exists
  ? staffDoc.data().name
  : "Anyone";

const editorLine = data.lastEditedBy ? `\n@${data.lastEditedBy}` : "";

await sendTelegram(
  `Appointment for <b>${staffName}</b> — ${formatDate(data.date)} at ${slotToTime(data.start)} was deleted.${editorLine}`
);
}
);
/* ================= OFF WORK TELEGRAM ================= */

// формат времени Off work
function formatOffTime(data) {
if (data.allDay) return "All day";
return `${slotToTime(data.start)} — ${slotToTime(data.end)}`;
}

// сообщение Off work
function buildOffWorkMessage(type, data, staffName) {
return `${type}
👩‍🎨 Staff member: ${staffName}
📅 Date: ${formatDate(data.date)}
⛔ Off work: ${formatOffTime(data)}`;
}

/* === OFF WORK CREATED === */
exports.offWorkCreated = onDocumentCreated(
"OffWork/{id}", // ⚠️ ВАЖНО: OffWork с большой буквы
async (event) => {
const data = event.data.data();

// ⛔️ Vacation days must NOT trigger OffWork messages
if (data.vacation === true) return;

// ===== WEEKLY EXCEPTION (Remove one day from weekly) =====
if (data.weeklyException === true) {
  const staffDoc = await admin
    .firestore()
    .doc(`staff/${data.staffId}`)
    .get();

  const staffName = staffDoc.exists
    ? staffDoc.data().name
    : "Unknown";

  await sendTelegram(
    `💃 ${staffName} will be working on ${formatDate(data.date)} instead of having a weekly day off.`
  );

  return;
}
// ===== FINISH WORK =====
if (data.finishWork === true) {
  if (data.finishWorkNotify !== true) return;

  const staffDoc = await admin
    .firestore()
    .doc(`staff/${data.staffId}`)
    .get();

  const staffName = staffDoc.exists
    ? staffDoc.data().name
    : "Unknown";

  await sendTelegram(
    `<b>${staffName}</b> finished for today at ${slotToTime(data.start)}.`
  );

  return;
}

const staffDoc = await admin
.firestore()
.doc(`staff/${data.staffId}`)
.get();

const staffName = staffDoc.exists
? staffDoc.data().name
: "Unknown";

let message = "";

if (data.allDay === true) {
  message = `💃 ${staffName} is off on ${formatDate(data.date)}`;
} else {
  message = `💃 ${staffName} is off on ${formatDate(data.date)} from ${slotToTime(data.start)} to ${slotToTime(data.end)}`;
}

await sendTelegram(message);

}
);
exports.offWorkUpdated = onDocumentUpdated(
  "OffWork/{id}",
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    // ❌ НЕ vacation
    if (after.vacation === true) return;

    // ❌ НЕ weekly exception
    if (after.weeklyException === true) return;

    

    const staffDoc = await admin
      .firestore()
      .doc(`staff/${after.staffId}`)
      .get();

    const staffName = staffDoc.exists
      ? staffDoc.data().name
      : "Unknown";

    // 🅰️ Full day → hours
if (before.allDay === true && after.allDay === false) {
  await sendTelegram(
    `💅 ${staffName} is now off on ${formatDate(after.date)} from ${slotToTime(after.start)} to ${slotToTime(after.end)}`
  );
  return;
}

// 🅱️ Hours → full day
if (before.allDay === false && after.allDay === true) {
  await sendTelegram(
    `💃 ${staffName} is now off for the full day on ${formatDate(after.date)}`
  );
  return;
}

// 🅾️ Hours → hours (time changed)
if (
  before.allDay === false &&
  after.allDay === false &&
  (before.start !== after.start || before.end !== after.end)
) {
  await sendTelegram(
    `✨ ${staffName}’s off hours on ${formatDate(after.date)} have been changed to ${slotToTime(after.start)} – ${slotToTime(after.end)}`
  );
  return;
}

  }
);


/* === OFF WORK DELETED === */
exports.offWorkDeleted = onDocumentDeleted(
  "OffWork/{id}",
  async (event) => {
    const data = event.data.data();
// ⛔️ Vacation days must NOT trigger OffWork messages
if (data.vacation === true) return;
    
    // ❌ НЕ шлём weekly exception
    if (data.weeklyException === true) return;

    const staffDoc = await admin
      .firestore()
      .doc(`staff/${data.staffId}`)
      .get();

    const staffName = staffDoc.exists
      ? staffDoc.data().name
      : "Unknown";

    let message = "";

if (data.allDay === true) {
  message = `💃 ${staffName}'s off day on ${formatDate(data.date)} has been removed`;
} else {
  message = `💃 ${staffName}'s off time on ${formatDate(data.date)} from ${slotToTime(data.start)} to ${slotToTime(data.end)} has been removed`;
}

await sendTelegram(message);

  }
);

exports.weeklyOffCreated = onDocumentCreated(
  "WeeklyOff/{id}",
  async (event) => {
    const data = event.data.data();

    const staffDoc = await admin
      .firestore()
      .doc(`staff/${data.staffId}`)
      .get();

    const staffName = staffDoc.exists
      ? staffDoc.data().name
      : "Unknown";

    const weekdays = [
      "Sunday","Monday","Tuesday","Wednesday",
      "Thursday","Friday","Saturday"
    ];

    let message = "";

if (data.allDay === true) {
  message = `💃 ${staffName} now has a weekly day off every ${weekdays[data.weekday]}.`;
} else {
  message =
    `💃 ${staffName} now has a weekly day off every ${weekdays[data.weekday]} from ${slotToTime(data.start)} to ${slotToTime(data.end)}.`;
}

await sendTelegram(message);

  }
);
exports.weeklyOffUpdated = onDocumentUpdated(
  "WeeklyOff/{id}",
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    // интересует ТОЛЬКО выключение
    if (before.enabled === true && after.enabled === false) {
      const staffDoc = await admin
        .firestore()
        .doc(`staff/${after.staffId}`)
        .get();

      const staffName = staffDoc.exists
        ? staffDoc.data().name
        : "Unknown";

      const weekdays = [
        "Sunday","Monday","Tuesday","Wednesday",
        "Thursday","Friday","Saturday"
      ];

      await sendTelegram(
        `💃 ${staffName}'s weekly day off on ${weekdays[after.weekday]} has been removed.`
      );
    }
  }
);

exports.vacationCreated = onDocumentCreated(
  "Vacations/{id}",
  async (event) => {
    const data = event.data.data();

    const staffDoc = await admin
      .firestore()
      .doc(`staff/${data.staffId}`)
      .get();

    const staffName = staffDoc.exists
      ? staffDoc.data().name
      : "Unknown";

    await sendTelegram(
      `🏖 ${staffName} is on vacation from ${data.startDate} to ${data.endDate}.`
    );
  }
);
exports.vacationDeleted = onDocumentDeleted(
  "Vacations/{id}",
  async (event) => {
    const data = event.data.data();

    const staffDoc = await admin
      .firestore()
      .doc(`staff/${data.staffId}`)
      .get();

    const staffName = staffDoc.exists
      ? staffDoc.data().name
      : "Unknown";

    await sendTelegram(
      `🏖 ${staffName}'s vacation from ${data.startDate} to ${data.endDate} has been removed.`
    );
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