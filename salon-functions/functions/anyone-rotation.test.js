"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { selectAnyoneCandidate, sortAnyoneCandidates } = require("./anyone-rotation");

test("Anyone candidates follow the manager's staff order", () => {
  const ordered = sortAnyoneCandidates([
    { id: "olena", name: "Olena", order: 3 },
    { id: "lan", name: "Lan", order: 1 },
    { id: "natalia", name: "Natalia", order: 2 }
  ]);
  assert.deepEqual(ordered.map(item => item.id), ["lan", "natalia", "olena"]);
});

test("Anyone rotation starts after the previous technician and wraps", () => {
  const candidates = [
    { id: "lan", order: 1 },
    { id: "natalia", order: 2 },
    { id: "olena", order: 3 }
  ];
  assert.equal(selectAnyoneCandidate(candidates, "lan").id, "natalia");
  assert.equal(selectAnyoneCandidate(candidates, "olena").id, "lan");
});

test("Anyone rotation skips unavailable technicians", () => {
  const candidate = selectAnyoneCandidate([
    { id: "lan", order: 1, available: false },
    { id: "natalia", order: 2, available: false },
    { id: "olena", order: 3, available: true }
  ], "lan");
  assert.equal(candidate.id, "olena");
});

test("Anyone rotation returns null when nobody is available", () => {
  assert.equal(selectAnyoneCandidate([
    { id: "lan", order: 1, available: false }
  ], ""), null);
});
