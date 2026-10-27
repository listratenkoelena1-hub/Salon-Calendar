"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectChatLanguage,
  getChatLanguageOptions,
  getChatTextHash,
  inferChatLanguage,
  normalizeChatLanguage,
  normalizeChatText,
  translateChatText
} = require("./staff-chat-translation");

test("normalizes the three supported chat languages", () => {
  assert.equal(normalizeChatLanguage("en-US"), "en");
  assert.equal(normalizeChatLanguage("RU_ru"), "ru");
  assert.equal(normalizeChatLanguage("uk"), "uk");
  assert.equal(normalizeChatLanguage("fr"), "");
  assert.deepEqual(getChatLanguageOptions("ru"), ["en", "uk"]);
});

test("local fallback distinguishes common English, Russian and Ukrainian text", () => {
  assert.equal(inferChatLanguage("Appointment moved"), "en");
  assert.equal(inferChatLanguage("Доброе утро"), "ru");
  assert.equal(inferChatLanguage("Добрий ранок, дякую"), "uk");
});

test("normalizes and hashes the exact chat text consistently", () => {
  assert.equal(normalizeChatText("  hello\r\nthere  "), "hello\nthere");
  assert.equal(getChatTextHash("hello\r\nthere"), getChatTextHash("  hello\nthere  "));
});

test("Cloud Translation language detection parses the v3 response", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ languages: [{ languageCode: "uk" }] }) };
  };
  const language = await detectChatLanguage({
    projectId: "demo-project",
    accessToken: "token",
    text: "Дякую",
    fetchImpl
  });
  assert.equal(language, "uk");
  assert.match(request.url, /locations\/global:detectLanguage$/);
  assert.equal(JSON.parse(request.options.body).content, "Дякую");
});

test("Cloud Translation sends a supported target and returns translated text", async () => {
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        translations: [{ translatedText: "Hello", detectedLanguageCode: "ru" }]
      })
    };
  };
  const result = await translateChatText({
    projectId: "demo-project",
    accessToken: "token",
    text: "Привет",
    targetLanguage: "en",
    fetchImpl
  });
  assert.deepEqual(result, { translatedText: "Hello", detectedLanguage: "ru" });
  assert.equal(body.targetLanguageCode, "en");
  assert.deepEqual(body.contents, ["Привет"]);
});
