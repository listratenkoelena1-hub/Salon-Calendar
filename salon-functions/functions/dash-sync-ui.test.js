"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);

test("shows ongoing Dash messages normally without treating Dash as a human Log editor", () => {
  assert.match(calendarHtml, /dash_appointment_added: 'Dash Booking appointment'/);
  assert.match(calendarHtml, /dash_appointment_rescheduled: 'Dash Booking rescheduled'/);
  assert.match(calendarHtml, /dash_appointment_canceled: 'Dash Booking canceled'/);
  assert.doesNotMatch(calendarHtml, /value: 'dash_booking', label: '@DashBooking'/);
});

test("archive preserves Dash Booking as a distinct appointment source", () => {
  assert.match(calendarHtml, /option value="dash_booking">Dash Booking/);
  assert.match(calendarHtml, /a\?\.source === 'dash_booking'/);
});

test("calendar interface has no experimental Dash audit window or callable dependency", () => {
  assert.doesNotMatch(calendarHtml, /dashAuditPreviewBtn/);
  assert.doesNotMatch(calendarHtml, /Dash Booking audit/);
  assert.doesNotMatch(calendarHtml, /managerRunDashBookingAudit/);
  assert.doesNotMatch(calendarHtml, /managerGetLatestDashBookingAudit/);
  assert.doesNotMatch(calendarHtml, /get\('dashAudit'\)/);
});

test("monitor-only Dash alerts open an editable appointment draft before saving", () => {
  assert.match(calendarHtml, /httpsCallable\(functions, "addDashMonitorAppointment"\)/);
  assert.match(calendarHtml, /data-dash-add-receipt-id/);
  assert.match(calendarHtml, />Add to calendar<\/button>/);
  assert.match(calendarHtml, /addDashMonitorAppointment\(\{ receiptId, preview: true \}\)/);
  assert.match(calendarHtml, /openDashAppointmentImportDraft\(result\.draft, receiptId, notificationId\)/);
  assert.match(calendarHtml, /pendingDashImportDraft/);
  assert.match(calendarHtml, /Review or change the information, then save it to Calendar/);
  assert.match(calendarHtml, /appointment: getAtomicAppointmentForm\(data\)/);
  assert.match(calendarHtml, /result\.status === 'conflict'/);
  assert.match(calendarHtml, /offWorkConflictModal/);
  assert.match(calendarHtml, /if \(pendingDashImportDraft\) \{\s*await saveDashAppointmentImportDraft\(data\);/);
  assert.match(calendarHtml, /window\.closeAppointment = \(\) => \{[\s\S]*?pendingDashImportDraft = null;/);
});

test("Bookings tab replaces Unread and contains every Online and Dash booking message", () => {
  assert.match(calendarHtml, /data-message-filter="bookings">Bookings<\/button>/);
  assert.doesNotMatch(calendarHtml, /data-message-filter="unread">Unread<\/button>/);
  assert.match(calendarHtml, /function isBookingStaffNotification\(item\)/);
  assert.match(calendarHtml, /source === 'online_booking' \|\| source === 'dash_booking'/);
  assert.match(calendarHtml, /eventType\.startsWith\('online_'\) \|\| eventType\.startsWith\('dash_'\)/);
  assert.match(calendarHtml, /staffMessagesFilter === 'bookings'[\s\S]*?filter\(isBookingStaffNotification\)/);
  assert.match(calendarHtml, /currentUserRole === 'manager'[\s\S]*?isBookingStaffNotification\(item\)[\s\S]*?'key'/);
});

test("Messenger paginates canonical messages as one chronological feed", () => {
  assert.match(calendarHtml, /let staffMessagesVisibleLimit = STAFF_MESSAGES_PAGE_SIZE/);
  assert.match(calendarHtml, /const queryLimit = staffMessagesVisibleLimit \+ 1/);
  assert.match(calendarHtml, /isCanonical\s*\? \[\]\s*:\s*\[where\('recipientStaffId'/);
  assert.match(calendarHtml, /function isStaffMessageVisibleToCurrentUser\(item, sourceKey\)/);
  assert.match(calendarHtml, /item\?\.visibleToAllStaff === true/);
  assert.match(calendarHtml, /filter\(item => isStaffMessageVisibleToCurrentUser\(item, sourceKey\)\)/);
  assert.match(calendarHtml, /const unsubscribers = \['canonical'\]\.map/);
  assert.doesNotMatch(calendarHtml, /\.\.\.staffMessageLatestPages\.legacy/);
  assert.match(calendarHtml, /const chronological = Array\.from\(merged\.values\(\)\)[\s\S]*?sort\(\(a, b\) => getStaffNotificationMillis\(a\) - getStaffNotificationMillis\(b\)\)/);
  assert.match(calendarHtml, /staffNotifications = chronological\.slice\(-staffMessagesVisibleLimit\)/);
  assert.match(calendarHtml, /staffMessagesVisibleLimit \+= STAFF_MESSAGES_PAGE_SIZE;\s*subscribeStaffMessageWindow\(\)/);
  assert.match(calendarHtml, /No messages in the loaded period/);
  assert.match(calendarHtml, /function buildStaffLoadEarlierButton\(\)/);
  assert.doesNotMatch(calendarHtml, /_olderPage|startAfter\(staffMessageOldestSnapshots/);
});
