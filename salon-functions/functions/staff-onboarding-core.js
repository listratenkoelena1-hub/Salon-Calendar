"use strict";

const STAFF_ONBOARDING_VERSION = "staff-onboarding-v1";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildStaffWelcomeEmail({ staffName, email, calendarUrl }) {
  const name = String(staffName || "Team member").trim() || "Team member";
  const loginEmail = String(email || "").trim().toLowerCase();
  const url = String(calendarUrl || "https://rosesnails-calendar.web.app").trim();
  const subject = "Welcome to Rose's Nails Londonderry";
  const text = [
    `Hello ${name},`,
    "",
    "Welcome to the Rose's Nails Londonderry team! Your calendar account is ready.",
    "",
    `Calendar: ${url}`,
    `Login email: ${loginEmail}`,
    "",
    "To create your password:",
    "1. Open the calendar.",
    "2. Tap Forgot password? on the Login screen.",
    "3. Enter the email address shown above and follow the link in the separate password reset email.",
    "",
    "If you do not see the password reset email, please check Spam, Junk, and other inbox folders.",
    "",
    "When you sign in for the first time, the calendar will show a short guide to its main features."
  ].join("\n");
  const html = [
    `<p>Hello ${escapeHtml(name)},</p>`,
    "<p>Welcome to the <strong>Rose's Nails Londonderry</strong> team! Your calendar account is ready.</p>",
    `<p><strong>Calendar:</strong> <a href="${escapeHtml(url)}">${escapeHtml(url)}</a><br><strong>Login email:</strong> ${escapeHtml(loginEmail)}</p>`,
    "<p><strong>To create your password:</strong></p>",
    "<ol><li>Open the calendar.</li><li>Tap <strong>Forgot password?</strong> on the Login screen.</li><li>Enter the email address shown above and follow the link in the separate password reset email.</li></ol>",
    "<p>If you do not see the password reset email, please check <strong>Spam</strong>, <strong>Junk</strong>, and other inbox folders.</p>",
    "<p>When you sign in for the first time, the calendar will show a short guide to its main features.</p>"
  ].join("");
  return { subject, text, html };
}

module.exports = {
  STAFF_ONBOARDING_VERSION,
  buildStaffWelcomeEmail
};
