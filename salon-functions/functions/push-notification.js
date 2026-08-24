"use strict";

function shouldProcessStaffPush(data = {}) {
  if (data.pushEligible === true) return true;

  return data.audienceVersion === 2 &&
    ["key", "message"].includes(String(data.managerPriority || ""));
}

module.exports = { shouldProcessStaffPush };
