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

test("translation is restricted to ordinary canonical chat messages", () => {
  assert.match(calendarHtml, /item\.eventType !== 'staff_message' \|\| item\.source !== 'calendar_chat'/);
  assert.match(calendarHtml, /item\._collection !== 'staffMessages'/);
  assert.match(functionsSource, /message\.eventType !== "staff_message" \|\| message\.source !== "calendar_chat"/);
  assert.match(functionsSource, /Only ordinary chat messages can be translated/);
});

test("chat cards detect the source language and render only the other two choices", () => {
  assert.match(calendarHtml, /detectStaffChatLanguageCall/);
  assert.match(calendarHtml, /translateStaffChatMessageCall/);
  assert.match(calendarHtml, /entry\.targetLanguages\.map/);
  assert.match(calendarHtml, /data-chat-translate-language/);
  assert.match(functionsSource, /targetLanguages: getChatLanguageOptions\(sourceLanguage\)/);
});

test("language actions share the sender row without changing the message width", () => {
  const headerCss = calendarHtml.match(/\.staff-message-chat-header \{([^}]+)\}/)?.[1] || "";
  const actionsCss = calendarHtml.match(/\.staff-message-language-actions \{([^}]+)\}/)?.[1] || "";
  assert.match(headerCss, /display: flex/);
  assert.match(headerCss, /justify-content: space-between/);
  assert.match(actionsCss, /flex: 0 0 auto/);
  assert.match(calendarHtml, /staff-message-chat-sender/);
});

test("server checks message visibility and caches translations privately", () => {
  assert.match(functionsSource, /canActorReadStaffChatMessage/);
  assert.match(functionsSource, /collection\("dashSyncConfig"\)[\s\S]*?collection\(CHAT_TRANSLATION_CACHE_COLLECTION\)/);
  assert.match(functionsSource, /cacheData\.translations\?\.\[targetLanguage\]/);
});
