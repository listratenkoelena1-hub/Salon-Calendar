"use strict";

const crypto = require("node:crypto");

const CHAT_LANGUAGE_CODES = new Set(["en", "ru", "uk"]);
const CHAT_MESSAGE_MAX_LENGTH = 500;

function normalizeChatLanguage(value) {
  const code = String(value || "").trim().toLowerCase().split(/[-_]/)[0];
  return CHAT_LANGUAGE_CODES.has(code) ? code : "";
}

function inferChatLanguage(text) {
  const value = String(text || "");
  if (/[іїєґ]/iu.test(value)) return "uk";
  if (/(?:дякую|будь ласка|добрий|гарного|сьогодні|завтра)/iu.test(value)) return "uk";
  if (/[ыэъё]/iu.test(value)) return "ru";
  if (/[а-я]/iu.test(value)) return "ru";
  return "en";
}

function normalizeChatText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim().slice(0, CHAT_MESSAGE_MAX_LENGTH);
}

function getChatTextHash(text) {
  return crypto.createHash("sha256").update(normalizeChatText(text), "utf8").digest("hex");
}

function getChatLanguageOptions(sourceLanguage) {
  const source = normalizeChatLanguage(sourceLanguage);
  return ["en", "ru", "uk"].filter(code => code !== source);
}

function assertTranslationResponse(response, field) {
  if (!response?.ok) {
    const status = Number(response?.status) || 500;
    throw new Error(`Cloud Translation request failed with HTTP ${status}.`);
  }
  const value = String(field || "").trim();
  if (!value) throw new Error("Cloud Translation returned an empty result.");
  return value;
}

async function detectChatLanguage({ projectId, accessToken, text, fetchImpl = fetch }) {
  const cleanText = normalizeChatText(text);
  if (!cleanText) throw new Error("Chat text is required.");
  const url = `https://translation.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/locations/global:detectLanguage`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content: cleanText, mimeType: "text/plain" })
  });
  const body = await response.json().catch(() => ({}));
  const detected = assertTranslationResponse(response, body?.languages?.[0]?.languageCode);
  return normalizeChatLanguage(detected) || inferChatLanguage(cleanText);
}

async function translateChatText({ projectId, accessToken, text, targetLanguage, fetchImpl = fetch }) {
  const cleanText = normalizeChatText(text);
  const target = normalizeChatLanguage(targetLanguage);
  if (!cleanText) throw new Error("Chat text is required.");
  if (!target) throw new Error("Unsupported target language.");
  const url = `https://translation.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/locations/global:translateText`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [cleanText],
      mimeType: "text/plain",
      targetLanguageCode: target
    })
  });
  const body = await response.json().catch(() => ({}));
  const translatedText = assertTranslationResponse(response, body?.translations?.[0]?.translatedText);
  const detectedLanguage = normalizeChatLanguage(body?.translations?.[0]?.detectedLanguageCode) || inferChatLanguage(cleanText);
  return { translatedText, detectedLanguage };
}

module.exports = {
  CHAT_LANGUAGE_CODES,
  CHAT_MESSAGE_MAX_LENGTH,
  detectChatLanguage,
  getChatLanguageOptions,
  getChatTextHash,
  inferChatLanguage,
  normalizeChatLanguage,
  normalizeChatText,
  translateChatText
};
