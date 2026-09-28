"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACTIONS,
  APPLY_CONFIRMATION,
  parseOptions,
  validatePostApply
} = require("./dash-one-day-apply-cli");

test("one-day apply requires the exact project, date, and confirmation", () => {
  assert.deepEqual(parseOptions([
    "--project=rosesnails-calendar",
    "--date=2026-09-28"
  ]), {
    projectId: "rosesnails-calendar",
    date: "2026-09-28",
    apply: false,
    confirmation: "",
    executablePath: ""
  });
  assert.equal(parseOptions([
    "--project=rosesnails-calendar",
    "--date=2026-09-28",
    "--apply",
    `--confirm=${APPLY_CONFIRMATION}`
  ]).apply, true);
  assert.throws(() => parseOptions([
    "--project=rosesnails-calendar",
    "--date=2026-09-28",
    "--apply"
  ]));
  assert.throws(() => parseOptions([
    "--project=other-project",
    "--date=2026-09-28"
  ]));
});

test("the approved plan contains six creates, two replacements, and one tail", () => {
  assert.equal(ACTIONS.filter(item => item.mode === "create").length, 6);
  assert.equal(ACTIONS.filter(item => item.mode === "replace").length, 2);
  assert.equal(ACTIONS.filter(item => item.mode === "tail").length, 1);
  assert.equal(ACTIONS.length, 9);
  assert.equal(
    ACTIONS.find(item => item.mode === "tail").block.description,
    "Rose Calendar | appt-tail:PW6323Kqpo6lwhslKhlP"
  );
});

test("post-apply verification keeps the client appointment and finds every block", () => {
  const day = {
    appointments: [{
      dashBookingId: "6ab96c2ac52ce67927e442fd",
      start: 30,
      duration: 12,
      staffName: "Olha"
    }],
    blocks: ACTIONS.map(action => ({
      description: action.block.description,
      dashStaffName: action.block.dashStaffName,
      start: action.block.start,
      end: action.block.end
    }))
  };
  assert.equal(validatePostApply(day), true);
  assert.throws(() => validatePostApply({ ...day, appointments: [] }));
});
