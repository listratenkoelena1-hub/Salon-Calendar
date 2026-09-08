"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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

const lookup = {
  phoneDigits: "7805551212",
  clientName: "alex smith",
  today: "2026-09-06",
  currentMinutes: 12 * 60
};

function appointment(overrides = {}) {
  return {
    source: "online_booking",
    type: "appointment",
    status: "confirmed",
    canceled: false,
    noShow: false,
    client: "Alex Smith",
    phone: "+1 (780) 555-1212",
    date: "2026-09-07",
    start: 20,
    ...overrides
  };
}

test("normalizes Canadian phone numbers and client names for private lookup", () => {
  assert.equal(normalizePhoneDigits("+1 (780) 555-1212"), "7805551212");
  assert.equal(normalizeClientName("  ALEX   Smith "), "alex smith");
  assert.ok(buildPhoneLookupVariants("7805551212").includes("(780) 555-1212"));
});

test("finds pending and confirmed future online appointments for the same client", () => {
  assert.equal(isUpcomingAppointmentForClient(appointment(), lookup), true);
  assert.equal(isUpcomingAppointmentForClient(appointment({
    type: "online_booking_request",
    status: "request"
  }), lookup), true);
});

test("does not expose unrelated, canceled, declined, mismatched, or past appointments", () => {
  assert.equal(isUpcomingAppointmentForClient(appointment({ source: null }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ canceled: true }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ status: "declined" }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ client: "Someone Else" }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ phone: "7805550000" }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ date: "2026-09-05" }), lookup), false);
  assert.equal(isUpcomingAppointmentForClient(appointment({ date: "2026-09-06", start: 12 }), lookup), false);
});

test("client cancellation closes pending requests without changing confirmed history", () => {
  assert.deepEqual(getClientCancellationRecordState({
    type: "online_booking_request",
    status: "request"
  }), {
    type: "appointment",
    status: "cancelled",
    canceled: true
  });
  assert.deepEqual(getClientCancellationRecordState({
    type: "appointment",
    status: "confirmed"
  }), {
    type: "appointment",
    status: "confirmed",
    canceled: true
  });
});

test("starts the photo deletion clock 24 hours after confirmation or decline", () => {
  const ttl = 24 * 60 * 60 * 1000;
  const confirmedAt = Date.UTC(2026, 8, 6, 18, 0, 0);
  const declinedAt = Date.UTC(2026, 8, 7, 2, 30, 0);

  assert.equal(
    getPhotoRetentionDeadlineMs({ status: "confirmed", confirmedAt }, ttl),
    confirmedAt + ttl
  );
  assert.equal(
    getPhotoRetentionDeadlineMs({ status: "declined", declinedAt }, ttl),
    declinedAt + ttl
  );
  assert.equal(getPhotoRetentionDeadlineMs({ status: "request" }, ttl), null);
  assert.equal(
    getPhotoRetentionDeadlineMs({ status: "cancelled", canceled: true, canceledAt: declinedAt }, ttl),
    declinedAt + ttl
  );
});

test("hashes one-time codes and session tokens without storing either value", () => {
  const codeHash = buildVerificationCodeHash({
    challengeId: "challenge_123456",
    code: "123456",
    secret: "test-secret"
  });
  const sameHash = buildVerificationCodeHash({
    challengeId: "challenge_123456",
    code: "123456",
    secret: "test-secret"
  });
  const wrongHash = buildVerificationCodeHash({
    challengeId: "challenge_123456",
    code: "654321",
    secret: "test-secret"
  });

  assert.equal(codeHash.length, 64);
  assert.equal(secureHashesEqual(codeHash, sameHash), true);
  assert.equal(secureHashesEqual(codeHash, wrongHash), false);
  assert.equal(buildSessionTokenHash("session-token").length, 64);
  assert.notEqual(buildSessionTokenHash("session-token"), buildSessionTokenHash("other-token"));
});

test("limits verification SMS sends with cooldown, hourly, and daily windows", () => {
  const now = Date.UTC(2026, 8, 8, 18, 0, 0);
  const first = getVerificationRateDecision(null, now);
  assert.deepEqual(first, {
    allowed: true,
    sendCount: 1,
    windowStartedAtMs: now,
    dailySendCount: 1,
    dailyWindowStartedAtMs: now,
    lastSentAtMs: now
  });

  const cooldown = getVerificationRateDecision({
    sendCount: 1,
    windowStartedAt: now,
    lastSentAt: now
  }, now + 30_000);
  assert.equal(cooldown.allowed, false);
  assert.equal(cooldown.reason, "cooldown");
  assert.equal(cooldown.retryAfterSeconds, 30);

  const limit = getVerificationRateDecision({
    sendCount: 3,
    windowStartedAt: now,
    lastSentAt: now - 120_000
  }, now + 10 * 60_000);
  assert.equal(limit.allowed, false);
  assert.equal(limit.reason, "hourly_limit");

  const reset = getVerificationRateDecision({
    sendCount: 3,
    windowStartedAt: now,
    dailySendCount: 2,
    dailyWindowStartedAt: now,
    lastSentAt: now
  }, now + 61 * 60_000);
  assert.equal(reset.allowed, true);
  assert.equal(reset.sendCount, 1);
  assert.equal(reset.dailySendCount, 3);

  const dailyLimit = getVerificationRateDecision({
    sendCount: 1,
    windowStartedAt: now + 5 * 60 * 60_000,
    dailySendCount: 6,
    dailyWindowStartedAt: now,
    lastSentAt: now
  }, now + 5 * 60 * 60_000 + 2 * 60_000);
  assert.equal(dailyLimit.allowed, false);
  assert.equal(dailyLimit.reason, "daily_limit");
});
