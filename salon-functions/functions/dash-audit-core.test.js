"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDashAuditPlan } = require("./dash-audit-core");

test("plans confirmed Dash appointments without creating duplicate Rose blocks", () => {
  const plan = buildDashAuditPlan({
    startDate: "2026-09-26",
    endDate: "2026-10-26",
    localAppointments: [{
      id: "local-1",
      date: "2026-10-02",
      staffId: "staff-1",
      start: 24,
      duration: 6,
      client: "Naomi",
      note: "Refill"
    }],
    desiredBlocks: [{
      sourceType: "appointment",
      sourceId: "local-1",
      date: "2026-10-02",
      start: "14:00",
      end: "15:30",
      dashStaffId: "dash-1",
      dashStaffName: "Tanya",
      description: "Rose Calendar | appt:local-1",
      fingerprint: "fp-1"
    }],
    dashAppointments: [{
      dashBookingId: "dash-booking-1",
      date: "2026-10-02",
      localStaffId: "staff-1",
      dashStaffId: "dash-1",
      staffName: "Tanya",
      start: 24,
      duration: 6,
      client: "Naomi",
      service: "Refill"
    }]
  });

  assert.equal(plan.summary.linkLocal, 1);
  assert.equal(plan.summary.createDashBlocks, 0);
  assert.equal(plan.rows[0].action, "link_local");
});

test("adopts exact manual coverage and replaces a partial manual block", () => {
  const desiredBlocks = [
    {
      sourceType: "appointment",
      sourceId: "appt-1",
      date: "2026-10-03",
      start: "10:00",
      end: "11:30",
      dashStaffId: "dash-1",
      dashStaffName: "Tanya",
      description: "Rose Calendar | appt:appt-1",
      fingerprint: "fp-1"
    },
    {
      sourceType: "off_work",
      sourceId: "off-1",
      date: "2026-10-04",
      start: "10:00",
      end: "12:00",
      dashStaffId: "dash-1",
      dashStaffName: "Tanya",
      description: "Rose Calendar | off:off-1",
      fingerprint: "fp-2"
    }
  ];
  const plan = buildDashAuditPlan({
    desiredBlocks,
    dashBlocks: [
      { date: "2026-10-03", start: "10:00", end: "11:30", dashStaffId: "dash-1", description: "Busy" },
      { date: "2026-10-04", start: "11:00", end: "12:30", dashStaffId: "dash-1", description: "Busy" }
    ]
  });

  assert.equal(plan.rows[0].action, "covered_by_manual_block");
  assert.equal(plan.rows[1].action, "replace_manual_block");
  assert.equal(plan.rows[1].reason, "manual_partial_overlap_replace");
  assert.equal(plan.summary.replaceManualBlocks, 1);
});

test("deduplicates equal intervals using date, technician, start, and duration", () => {
  const plan = buildDashAuditPlan({
    desiredBlocks: [
      {
        sourceType: "off_work",
        sourceId: "older-weekly-rule",
        date: "2026-10-04",
        start: "10:00",
        end: "12:00",
        dashStaffId: "dash-1",
        dashStaffName: "Inna",
        description: "Rose Calendar | off:older-weekly-rule"
      },
      {
        sourceType: "off_work",
        sourceId: "newer-weekly-rule",
        date: "2026-10-04",
        startMinutes: 600,
        durationMinutes: 120,
        dashStaffId: "dash-1",
        dashStaffName: "Inna",
        description: "Rose Calendar | off:newer-weekly-rule"
      }
    ]
  });

  assert.equal(plan.rows.length, 1);
  assert.equal(plan.summary.createDashBlocks, 1);
  assert.equal(plan.summary.duplicateRoseBlocks, 1);
});

test("updates an integration-owned block when its time changed", () => {
  const plan = buildDashAuditPlan({
    desiredBlocks: [{
      sourceType: "appointment",
      sourceId: "appt-2",
      date: "2026-10-05",
      start: "12:00",
      end: "13:30",
      dashStaffId: "dash-1",
      dashStaffName: "Tanya",
      description: "Rose Calendar | appt:appt-2",
      fingerprint: "fp-new"
    }],
    dashBlocks: [{
      dashBlockId: "block-2",
      date: "2026-10-05",
      start: "12:00",
      end: "13:00",
      dashStaffId: "dash-1",
      description: "Rose Calendar | appt:appt-2"
    }]
  });

  assert.equal(plan.summary.updateDashBlocks, 1);
  assert.equal(plan.rows[0].action, "update_dash_block");
});

test("does not create redundant blocks for a technician already off in the Dash working schedule", () => {
  const plan = buildDashAuditPlan({
    desiredBlocks: [{
      sourceType: "off_work",
      sourceId: "off-luba",
      date: "2026-09-28",
      start: "10:00",
      end: "20:00",
      dashStaffId: "dash-luba",
      dashStaffName: "Luba",
      description: "Rose Calendar | off:off-luba"
    }],
    dashWorkingStaffByDate: {
      "2026-09-28": ["Olha", "Olena", "Iryna", "Natalia", "Cindy", "Lan"]
    }
  });

  assert.equal(plan.rows[0].action, "covered_by_dash_schedule");
  assert.equal(plan.rows[0].reason, "staff_not_working_in_dash");
  assert.equal(plan.summary.alreadyMatched, 1);
  assert.equal(plan.summary.createDashBlocks, 0);
});
