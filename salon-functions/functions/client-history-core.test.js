"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyHistoryPreferences,
  chooseProfileMatch,
  filterClientHistoryRecordsForIdentity,
  getClientNoShowWarning,
  getNameMatch,
  getPersonalizedDuration,
  getServiceFingerprint,
  hashPhone,
  isCompatibleClientName,
  isSameClientName,
  normalizeClientName,
  normalizePhone,
  parseServiceIntent,
  stripPrivateAppointmentFields,
  summarizeClientHistory
} = require("./client-history-core");

test("warns about recent No Shows, resets after attendance, and keeps a rolling twelve-month high-risk count", () => {
  const record = (date, values = {}) => ({
    status: "confirmed",
    staffId: "elena",
    note: "Manicure",
    date,
    ...values
  });
  assert.equal(
    getClientNoShowWarning([record("2026-10-20", { noShow: true })], "2026-11-04"),
    "This client did not attend their previous appointment."
  );
  assert.equal(
    getClientNoShowWarning([
      record("2026-10-20", { noShow: true }),
      record("2026-10-01", { noShow: true })
    ], "2026-11-04"),
    "This client missed their last 2 appointments."
  );
  assert.equal(
    getClientNoShowWarning([
      record("2026-10-25"),
      record("2026-10-20", { noShow: true })
    ], "2026-11-04"),
    ""
  );
  assert.equal(
    getClientNoShowWarning([
      record("2026-10-25"),
      record("2026-10-20", { noShow: true }),
      record("2026-08-20", { noShow: true }),
      record("2026-06-20", { noShow: true }),
      record("2026-04-20", { noShow: true }),
      record("2026-01-20", { noShow: true }),
      record("2025-10-20", { noShow: true })
    ], "2026-11-04"),
    "This client has 5 No Shows in the last 12 months."
  );
});

test("normalizes supported phone formats and rejects incomplete numbers", () => {
  assert.equal(normalizePhone("(780) 555-0123"), "+17805550123");
  assert.equal(normalizePhone("+1 780 555 0123"), "+17805550123");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("555-0123"), "");
  assert.equal(hashPhone("7805550123", "test-pepper").length, 64);
  assert.notEqual(hashPhone("7805550123", "pepper-a"), hashPhone("7805550123", "pepper-b"));
});

test("keeps short names strict and accepts small spelling mistakes in longer names", () => {
  assert.equal(normalizeClientName("  Darlène "), "darlene");
  assert.equal(isSameClientName("  nina cardinal ", "Nina   Cardinal"), true);
  assert.equal(isSameClientName("Nina Cardinal", "Nina Cardin"), false);
  assert.deepEqual(getNameMatch("Darlene", "Darlene"), { type: "exact", distance: 0, score: 1 });
  assert.equal(getNameMatch("Li", "Lu"), null);
  assert.equal(getNameMatch("Darlene", "Darlne")?.type, "close");
  assert.equal(getNameMatch("Griselda", "Grizelda")?.type, "close");
  assert.equal(getNameMatch("Barbara", "Deborah"), null);
});

test("joins name variants only when they belong to the same normalized phone client", () => {
  const records = [
    { id: "first", clientId: "phone-client", clientProfileId: "lowercase-profile", client: "nina cardinal" },
    { id: "second", clientId: "phone-client", clientProfileId: "titlecase-profile", client: "Nina Cardinal" },
    { id: "short", clientId: "phone-client", clientProfileId: "short-profile", client: "Nina" },
    { id: "third", clientId: "phone-client", clientProfileId: "other-person", client: "Nina Cardin" },
    { id: "fourth", clientId: "different-phone", clientProfileId: "different", client: "Nina Cardinal" }
  ];
  assert.deepEqual(
    filterClientHistoryRecordsForIdentity(records, {
      clientId: "phone-client",
      clientProfileId: "titlecase-profile",
      clientNameNormalized: "nina cardinal"
    }).map(record => record.id),
    ["first", "second", "short"]
  );
  assert.deepEqual(
    filterClientHistoryRecordsForIdentity(records, {
      clientId: "different-current-client",
      clientProfileId: "different-current-profile",
      clientNameNormalized: "nina cardinal"
    }).map(record => record.id),
    []
  );
  assert.equal(isCompatibleClientName("Nina", "Nina Cardinal"), true);
  assert.equal(isCompatibleClientName("Nina", "Nina Cardin"), true);
  assert.equal(isCompatibleClientName("Nina Cardinal", "Nina Cardin"), false);
});

test("selects a unique close profile but does not guess between tied people on one phone", () => {
  const profiles = [
    { id: "darlene", displayName: "Darlene", aliases: [] },
    { id: "deborah", displayName: "Deborah", aliases: [] }
  ];
  assert.equal(chooseProfileMatch("Darlne", profiles)?.profile.id, "darlene");
  assert.equal(chooseProfileMatch("Nina", [
    { id: "nina-cardinal", displayName: "Nina Cardinal" },
    { id: "deborah", displayName: "Deborah" }
  ])?.profile.id, "nina-cardinal");

  const ambiguous = chooseProfileMatch("Maria", [
    { id: "marla", displayName: "Marla" },
    { id: "marta", displayName: "Marta" }
  ]);
  assert.equal(ambiguous?.ambiguous, true);
  assert.equal(ambiguous?.profile, null);
});

test("paraffin is ignored while pedicure remains a generic pedicure", () => {
  const paraffinOnly = parseServiceIntent("Paraffin");
  assert.equal(paraffinOnly.hands, null);
  assert.equal(paraffinOnly.feet, null);

  const pedicureParaffin = parseServiceIntent("Pedi + paraffin");
  assert.equal(pedicureParaffin.feet.key, "generic_pedicure");
  assert.equal(pedicureParaffin.hands, null);
  assert.equal(parseServiceIntent("педикюр парафин").feet.key, "generic_pedicure");
});

test("recognizes the approved short manicure and pedicure forms", () => {
  assert.equal(parseServiceIntent("P").feet.key, "generic_pedicure");
  assert.equal(parseServiceIntent("M").hands.key, "generic_manicure");
  assert.equal(parseServiceIntent("F").hands.key, "refill");
  assert.equal(parseServiceIntent("R").hands.key, "refill");
  assert.equal(parseServiceIntent("P+M").feet.key, "generic_pedicure");
  assert.equal(parseServiceIntent("P+M").hands.key, "generic_manicure");
  assert.equal(parseServiceIntent("PM").feet.key, "generic_pedicure");
  assert.equal(parseServiceIntent("PM").hands.key, "generic_manicure");
});

test("recognizes separate hands and feet branches in a combined request", () => {
  const intent = parseServiceIntent({
    selectedServices: ["Manicure", "Hard gel", "Refill", "Design", "Pedicure", "Regular polish"]
  });
  assert.equal(intent.hands.key, "hard_gel_refill");
  assert.equal(intent.hands.design, true);
  assert.equal(intent.feet.key, "regular_polish");
  assert.equal(intent.feet.design, null);
  assert.equal(
    getServiceFingerprint(intent),
    "hands:hard_gel_refill:design|feet:regular_polish"
  );
});

test("applies an unqualified design in a combined request to hands only", () => {
  const intent = parseServiceIntent("P+M design");
  assert.equal(intent.hands.design, true);
  assert.equal(intent.feet.design, null);

  const noDesign = parseServiceIntent("PM no design");
  assert.equal(noDesign.hands.design, false);
  assert.equal(noDesign.feet.design, null);
});

test("recognizes common typed manicure and pedicure descriptions", () => {
  assert.equal(parseServiceIntent("acrylic refill").hands.key, "acrylic_refill");
  assert.equal(parseServiceIntent("builder gel new set").hands.key, "hard_gel_new_set");
  assert.equal(parseServiceIntent("mani no color").hands.key, "no_color");
  assert.equal(parseServiceIntent("pedi gel polish").feet.key, "gel_polish");
  assert.equal(parseServiceIntent("pedi gel").feet.key, "gel_polish");
  assert.equal(parseServiceIntent("gel pedi").feet.key, "gel_polish");
  assert.equal(parseServiceIntent("toe color change").feet.key, "change_color");
  assert.equal(parseServiceIntent("toes").feet.key, "change_color");
  assert.equal(parseServiceIntent("cut toe nails").feet.key, "generic_pedicure");
  assert.equal(parseServiceIntent("cut toe nails").hands, null);
  assert.equal(parseServiceIntent("pedi no washing").feet.key, "no_color");
  assert.equal(parseServiceIntent("deluxe pedi").feet.key, "deluxe");
  assert.equal(parseServiceIntent("one nail extension").hands.key, "one_nail_extension");
  assert.equal(parseServiceIntent("маникюр гель-лак дизайн").hands.key, "gel_polish");
  assert.equal(parseServiceIntent("маникюр гель-лак дизайн").hands.design, true);
  assert.equal(parseServiceIntent("педикюр обычный лак").feet.key, "regular_polish");
  assert.equal(parseServiceIntent({
    serviceDetails: "gel polish",
    requestedGroups: ["manicure"]
  }).hands.key, "gel_polish");
  assert.equal(parseServiceIntent({
    serviceDetails: "regular polish",
    requestedGroups: ["pedicure"]
  }).feet.key, "regular_polish");
});

test("treats standalone nails and powder wording as a full nail extension service", () => {
  for (const text of [
    "nails",
    "nail",
    "powder",
    "powder nails",
    "coffin nails",
    "square nails",
    "short nails",
    "long nails",
    "new nails"
  ]) {
    assert.equal(parseServiceIntent(text).hands.key, "extensions", text);
  }
  assert.equal(parseServiceIntent("powder nails with design").hands.key, "extensions");
});

test("keeps maintenance and single-nail phrases out of full extensions", () => {
  for (const text of ["cut nails", "nail trim", "change nail shape", "reshape nails", "remove nails"]) {
    assert.equal(parseServiceIntent(text).hands.key, "generic_manicure", text);
  }
  for (const text of ["one nail extension", "one fake nail", "repair one nail"]) {
    assert.equal(parseServiceIntent(text).hands.key, "one_nail_extension", text);
  }
});

test("does not learn a one-nail repair as the client's usual hand service", () => {
  const summary = summarizeClientHistory([
    { status: "confirmed", staffId: "natasha", note: "One nail extension" },
    { status: "confirmed", staffId: "natasha", note: "One nail extension" }
  ]);
  assert.equal(summary.hands, null);
});

test("applies a repeated generic service and its latest personal duration together", () => {
  const history = [
    {
      appointmentId: "first",
      status: "confirmed",
      staffId: "natasha",
      note: "Mani hard gel refill",
      standardDuration: 6,
      duration: 6,
      date: "2026-07-01"
    },
    {
      appointmentId: "latest",
      status: "confirmed",
      staffId: "natasha",
      note: "Mani hard gel refill",
      standardDuration: 6,
      duration: 8,
      date: "2026-08-01"
    }
  ];
  const summary = summarizeClientHistory(history);
  const inferred = applyHistoryPreferences(parseServiceIntent("Mani"), summary);
  assert.equal(inferred.hands.key, "hard_gel_refill");
  assert.deepEqual(getPersonalizedDuration(summary, "natasha", inferred, 6), {
    duration: 8,
    standardDuration: 6,
    personalized: true,
    serviceFingerprint: "hands:hard_gel_refill",
    sourceAppointmentId: "latest"
  });
});

test("uses repeated history only to clarify a generic service", () => {
  const summary = summarizeClientHistory([
    { status: "confirmed", staffId: "natasha", note: "Mani hard gel refill" },
    { status: "confirmed", staffId: "natasha", note: "Mani hard gel refill" },
    { status: "confirmed", staffId: "natasha", note: "Pedi regular polish" },
    { status: "confirmed", staffId: "natasha", note: "Pedi regular polish" }
  ]);

  const generic = applyHistoryPreferences(parseServiceIntent("mani pedi"), summary);
  assert.equal(generic.hands.key, "hard_gel_refill");
  assert.equal(generic.hands.inferredFromHistory, true);
  assert.equal(generic.feet.key, "regular_polish");

  const explicit = applyHistoryPreferences(parseServiceIntent("mani gel polish"), summary);
  assert.equal(explicit.hands.key, "gel_polish");
  assert.equal(explicit.hands.inferredFromHistory, undefined);
});

test("uses history to complete a partial refill without overriding an explicit material", () => {
  const summary = summarizeClientHistory([
    {
      appointmentId: "one",
      status: "confirmed",
      staffId: "natasha",
      note: "Mani hard gel refill",
      standardDuration: 6,
      duration: 8,
      date: "2026-07-01"
    },
    {
      appointmentId: "two",
      status: "confirmed",
      staffId: "natasha",
      note: "Mani hard gel refill",
      standardDuration: 6,
      duration: 8,
      date: "2026-08-01"
    }
  ]);

  const refill = applyHistoryPreferences(parseServiceIntent("refill"), summary);
  assert.equal(refill.hands.key, "hard_gel_refill");
  assert.equal(refill.hands.inferredFromHistory, true);
  assert.equal(getPersonalizedDuration(summary, "natasha", refill, 6).duration, 8);

  const hardGel = applyHistoryPreferences(parseServiceIntent("hard gel"), summary);
  assert.equal(hardGel.hands.key, "hard_gel_refill");

  const explicitAcrylic = applyHistoryPreferences(parseServiceIntent("acrylic refill"), summary);
  assert.equal(explicitAcrylic.hands.key, "acrylic_refill");
  assert.equal(explicitAcrylic.hands.inferredFromHistory, undefined);
});

test("requires repetition before calling a service a preference", () => {
  const summary = summarizeClientHistory([
    { status: "confirmed", staffId: "natasha", note: "Mani hard gel refill" },
    { status: "confirmed", staffId: "natasha", note: "Pedi gel polish" }
  ]);
  assert.equal(summary.hands, null);
  assert.equal(summary.feet, null);
  assert.equal(summary.preferredStaff, null);
});

test("counts canceled and no-show visits but excludes pending and declined requests", () => {
  const summary = summarizeClientHistory([
    { status: "confirmed", staffId: "natasha", note: "Mani no color" },
    { status: "confirmed", canceled: true, staffId: "natasha", note: "Mani no color" },
    { status: "confirmed", noShow: true, staffId: "natasha", note: "Mani no color" },
    { status: "request", staffId: "elena", note: "Mani gel polish" },
    { status: "declined", staffId: "elena", note: "Mani gel polish" }
  ]);
  assert.deepEqual(summary.preferredStaff, { staffId: "natasha", count: 3 });
  assert.equal(summary.hands.key, "no_color");
  assert.equal(summary.hands.count, 3);
  assert.equal(summary.noShowCount, 1);
});

test("latest adjusted duration becomes the override and a later standard visit clears it", () => {
  const base = {
    status: "confirmed",
    staffId: "natasha",
    note: "Mani hard gel refill",
    standardDuration: 6
  };
  const firstSummary = summarizeClientHistory([
    { ...base, appointmentId: "one", duration: 8, date: "2026-08-01" }
  ]);
  const intent = parseServiceIntent("Mani hard gel refill");
  assert.deepEqual(getPersonalizedDuration(firstSummary, "natasha", intent, 6), {
    duration: 8,
    standardDuration: 6,
    personalized: true,
    serviceFingerprint: "hands:hard_gel_refill",
    sourceAppointmentId: "one"
  });

  const clearedSummary = summarizeClientHistory([
    { ...base, appointmentId: "one", duration: 8, date: "2026-08-01" },
    { ...base, appointmentId: "two", duration: 6, date: "2026-09-01" }
  ]);
  assert.equal(getPersonalizedDuration(clearedSummary, "natasha", intent, 6).personalized, false);
});

test("orders duration history by appointment date instead of a later status edit", () => {
  const summary = summarizeClientHistory([
    {
      appointmentId: "older-edited-today",
      status: "confirmed",
      canceled: true,
      staffId: "natasha",
      note: "Mani hard gel refill",
      standardDuration: 6,
      duration: 9,
      date: "2026-07-01",
      updatedAt: 9999999999999
    },
    {
      appointmentId: "newer-visit",
      status: "confirmed",
      staffId: "natasha",
      note: "Mani hard gel refill",
      standardDuration: 6,
      duration: 8,
      date: "2026-08-01",
      updatedAt: 1
    }
  ]);
  const intent = parseServiceIntent("Mani hard gel refill");
  assert.equal(getPersonalizedDuration(summary, "natasha", intent, 6).duration, 8);
});

test("does not reuse an adjusted duration for another service or technician", () => {
  const summary = summarizeClientHistory([
    {
      status: "confirmed",
      staffId: "natasha",
      note: "Mani hard gel refill",
      standardDuration: 6,
      duration: 8,
      date: "2026-08-01"
    }
  ]);
  assert.equal(
    getPersonalizedDuration(summary, "elena", parseServiceIntent("Mani hard gel refill"), 6).duration,
    6
  );
  assert.equal(
    getPersonalizedDuration(summary, "natasha", parseServiceIntent("Mani gel polish"), 4).duration,
    4
  );
});

test("never shortens the current technician duration from client history", () => {
  const intent = parseServiceIntent("Mani hard gel refill");
  const shorterSummary = summarizeClientHistory([
    {
      appointmentId: "shorter",
      status: "confirmed",
      staffId: "natasha",
      note: "Mani hard gel refill",
      standardDuration: 8,
      duration: 6,
      date: "2026-08-01"
    }
  ]);
  assert.equal(getPersonalizedDuration(shorterSummary, "natasha", intent, 8).duration, 8);

  const oldLongerSummary = summarizeClientHistory([
    {
      appointmentId: "old-longer",
      status: "confirmed",
      staffId: "natasha",
      note: "Mani hard gel refill",
      standardDuration: 6,
      duration: 8,
      date: "2026-08-01"
    }
  ]);
  assert.equal(getPersonalizedDuration(oldLongerSummary, "natasha", intent, 9).duration, 9);
});

test("removes every private identity and contact field from a calendar appointment", () => {
  assert.deepEqual(stripPrivateAppointmentFields({
    date: "2026-09-10",
    client: "Darlene",
    note: "Pedi",
    phone: "7805550123",
    phoneLookup: "7805550123",
    phoneNormalized: "+17805550123",
    phoneDisplay: "(780) 555-0123",
    phoneLast4: "0123",
    phoneHash: "secret-index",
    contactPhone: "7805550123",
    email: "private@example.com",
    clientId: "client-id",
    clientProfileId: "profile-id",
    profileId: "profile-id"
  }), {
    date: "2026-09-10",
    client: "Darlene",
    note: "Pedi"
  });
});
