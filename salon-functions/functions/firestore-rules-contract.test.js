"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rules = fs.readFileSync(
  path.join(__dirname, "..", "..", "salon-calendar", "firestore.rules"),
  "utf8"
);

const serverOnlyCollections = [
  "appointmentPrivate",
  "clientLookup",
  "clientProfiles",
  "clientPhoneIndex",
  "clientAppointmentHistory",
  "onlineBookingVerificationChallenges",
  "onlineBookingVerificationRateLimits",
  "onlineBookingEmailContacts",
  "onlineBookingSubmissions",
  "onlineBookingPhotos",
  "EmailQueue",
  "SmsQueue"
];

test("private client and delivery collections are denied to every browser role", () => {
  serverOnlyCollections.forEach(collection => {
    assert.match(
      rules,
      new RegExp(`match /${collection}/\\{document=\\*\\*\\} \\{\\s*allow read, write: if false;`),
      `${collection} must be server-only`
    );
    assert.match(
      rules,
      new RegExp(`collection != '${collection}'`),
      `${collection} must also be excluded from the generic fallback`
    );
  });
});

test("calendar appointments remain readable but browser writes stay server-mediated", () => {
  assert.match(rules, /match \/appointments\/\{document=\*\*\}[\s\S]*?allow read: if signedIn\(\);[\s\S]*?allow create, update, delete: if false;/);
});

test("only managers can read activity log contacts", () => {
  assert.match(rules, /match \/activityLog\/\{logId\}[\s\S]*?allow read, update, delete: if hasRole\('manager'\);/);
  assert.match(rules, /collection != 'activityLog'/);
});
