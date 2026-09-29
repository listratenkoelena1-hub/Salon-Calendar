"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const calendarHtml = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "index.html"),
  "utf8"
);
const functionsSource = fs.readFileSync(
  path.join(__dirname, "index.js"),
  "utf8"
);

test("staff settings labels and manager online-booking controls are present", () => {
  assert.match(
    calendarHtml,
    /id="staffMenuItem"[^>]*>Staff Settings<\/div>/
  );
  assert.match(calendarHtml, /<h3>Staff Settings<\/h3>/);
  assert.match(
    calendarHtml,
    /<span>Notifications<\/span><span>Online Booking<\/span>/
  );
  assert.match(calendarHtml, /id="newStaffOnlineBooking" checked/);
  assert.match(calendarHtml, /data-staff-online-booking="\$\{s\.id\}"/);
});

test("legacy staff defaults to online booking and manager saves an explicit value", () => {
  assert.match(
    calendarHtml,
    /function isStaffOnlineBookingEnabled\(staffMember\) \{\s*return staffMember\?\.bookingEnabled !== false;\s*\}/
  );
  assert.match(
    calendarHtml,
    /bookingEnabled: newStaffOnlineBooking \? newStaffOnlineBooking\.checked : true/
  );
  assert.match(
    calendarHtml,
    /payload\.bookingEnabled = bookingEnabled;/
  );
});

test("staff settings actions are outside the independently scrolling table", () => {
  const scrollStart = calendarHtml.indexOf('<div id="staffScroll">');
  const footerStart = calendarHtml.indexOf('<div class="modal-actions staff-modal-actions">');
  const footerEnd = calendarHtml.indexOf("</div>", footerStart);
  const closeButton = calendarHtml.indexOf('<button onclick="closeStaff()">Close</button>');

  assert.ok(scrollStart >= 0, "staff scroll container must exist");
  assert.ok(footerStart > scrollStart, "footer must follow the scrolling table");
  assert.ok(closeButton > footerStart && closeButton < footerEnd, "Close must live in the fixed footer");
  assert.match(
    calendarHtml,
    /#staffModal #staffScroll\{[\s\S]*?overflow: auto;/
  );
  assert.match(
    calendarHtml,
    /#staffModal \.staff-modal-actions\{[\s\S]*?flex: 0 0 auto;/
  );
});

test("online booking backend excludes disabled technicians everywhere", () => {
  const availabilityFilters = functionsSource.match(/\.filter\(s => s\.bookingEnabled !== false\)/g) || [];
  assert.ok(
    availabilityFilters.length >= 2,
    "named-technician availability and Anyone capacity must both filter disabled staff"
  );
  assert.match(
    functionsSource,
    /!selectedStaff \|\| selectedStaff\.bookingEnabled === false \|\| !staffCanDoServiceGroups/
  );
});
