"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);
const functionsSource = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

test("appointment layout separates Client, Group, and Client History", () => {
  const clientIndex = calendarHtml.indexOf('class="ap-row ap-client-row"');
  const groupIndex = calendarHtml.indexOf('id="appointmentGroupRow"');
  const historyIndex = calendarHtml.indexOf('id="clientHistoryLinkRow"');
  const serviceIndex = calendarHtml.indexOf('>Service</div>', historyIndex);
  assert.ok(clientIndex >= 0);
  assert.ok(groupIndex > clientIndex);
  assert.ok(historyIndex > groupIndex);
  assert.ok(serviceIndex > historyIndex);
  assert.match(calendarHtml, /appointmentGroupRow\?\.classList\.toggle\('is-hidden', !canEditGroup\)/);
});

test("Client History uses stacked modals and preserves the appointment editor", () => {
  assert.match(calendarHtml, /id="clientHistoryModal" class="modal hidden"/);
  assert.match(calendarHtml, /id="clientHistoryDetailModal" class="modal hidden"/);
  assert.match(calendarHtml, /appointmentModal\.inert = true/);
  assert.match(calendarHtml, /appointmentModal\.inert = false/);
  assert.match(calendarHtml, /getAppointmentClientHistory\(\{ appointmentId: appointment\.id \}\)/);
});

test("Client History uses the compact minimal table treatment", () => {
  const historyModalStart = calendarHtml.indexOf('id="clientHistoryModal"');
  const historyDetailStart = calendarHtml.indexOf('id="clientHistoryDetailModal"');
  const historyModalHtml = calendarHtml.slice(historyModalStart, historyDetailStart);

  assert.doesNotMatch(historyModalHtml, /aria-label="Close Client History">×<\/button>/);
  assert.match(historyModalHtml, /Details<span class="client-history-header-note">\(Tap to Open\)<\/span>/);
  assert.match(calendarHtml, /\.client-history-client-name \{\s*font-weight: 700;/);
  assert.match(calendarHtml, /\.client-history-table-wrap \{[\s\S]*?overflow: auto;[\s\S]*?margin-top: 10px;[\s\S]*?-webkit-overflow-scrolling: touch;/);
  assert.match(calendarHtml, /\.client-history-table \{[\s\S]*?width: max-content;[\s\S]*?min-width: 0;/);
  assert.match(calendarHtml, /\.client-history-details-link \{[\s\S]*?text-decoration: none;/);
});

test("Client History phone is conditionally returned only to a manager", () => {
  assert.match(functionsSource, /\["manager", "staff"\]\.includes\(actor\.role\)/);
  assert.match(functionsSource, /actor\.role === "manager"[\s\S]*?\? \{ phone:/);
  assert.match(calendarHtml, /currentUserRole === 'manager' && result\.phone/);
});

test("Anyone requests store the original choice and actual technician", () => {
  assert.match(functionsSource, /requestedStaffId,/);
  assert.match(functionsSource, /autoAssignedFromAnyone: requestedStaffId === ANYONE_ID/);
  assert.match(functionsSource, /anyoneAssignedStaffId: requestedStaffId === ANYONE_ID \? assignedStaffId : null/);
  assert.match(functionsSource, /Assigned to <b>\$\{staffName\}<\/b> by the Anyone rotation\./);
});
