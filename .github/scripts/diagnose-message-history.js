"use strict";

const admin = require("firebase-admin");

admin.initializeApp({ projectId: "rosesnails-calendar" });
const db = admin.firestore();

function dateKey(value) {
  const date = value?.toDate ? value.toDate() : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : "missing";
}

async function summarize(collectionName) {
  const snapshot = await db.collection(collectionName)
    .orderBy("createdAt", "desc")
    .limit(2000)
    .select("createdAt", "visibleToAllStaff", "visibleToManager", "audienceStaffIds", "recipientStaffId", "expiresAt")
    .get();
  const days = {};
  let visibleToAll = 0;
  let withAudience = 0;
  let withRecipient = 0;
  let withExpiry = 0;
  snapshot.docs.forEach(docSnap => {
    const data = docSnap.data() || {};
    const key = dateKey(data.createdAt);
    days[key] = (days[key] || 0) + 1;
    if (data.visibleToAllStaff === true) visibleToAll += 1;
    if (Array.isArray(data.audienceStaffIds) && data.audienceStaffIds.length) withAudience += 1;
    if (String(data.recipientStaffId || "")) withRecipient += 1;
    if (data.expiresAt) withExpiry += 1;
  });
  return {
    collection: collectionName,
    documentsRead: snapshot.size,
    newestDate: dateKey(snapshot.docs[0]?.data()?.createdAt),
    oldestDate: dateKey(snapshot.docs[snapshot.docs.length - 1]?.data()?.createdAt),
    visibleToAll,
    withAudience,
    withRecipient,
    withExpiry,
    days
  };
}

Promise.all([summarize("staffMessages"), summarize("staffNotifications")])
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
