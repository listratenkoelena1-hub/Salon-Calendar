"use strict";

const os = require("node:os");
const path = require("node:path");
const {
  minutesToTime,
  parseDashAppointmentDetail,
  parseDashNotification,
  stableHash
} = require("./dash-sync-core");

const DASH_BASE_URL = "https://www.partnersdash.com";
const DASH_APPOINTMENTS_URL = `${DASH_BASE_URL}/appointments`;
const DEFAULT_TIMEOUT_MS = 30000;
const DASH_LOGIN_TIMEOUT_MS = 90000;
const DASH_EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[id*="email" i]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[placeholder*="email" i]'
];
const DASH_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[id*="password" i]',
  'input[autocomplete="current-password"]',
  'input[placeholder*="password" i]'
];
const DASH_READY_SELECTORS = [
  '[aria-label="bell"]',
  'button[aria-label="plus"]',
  'input[placeholder="Select date"]',
  '.react-grid-layout'
];

function toTwelveHour(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return "";
  const hour24 = Number(match[1]);
  const minute = match[2];
  if (hour24 > 23) return "";
  const meridiem = hour24 >= 12 ? "pm" : "am";
  const hour12 = hour24 % 12 || 12;
  return `${String(hour12).padStart(2, "0")}:${minute} ${meridiem}`;
}

function buildCreateBlockUrl(block) {
  const params = new URLSearchParams({
    date: block.date,
    start: block.start,
    staff: block.dashStaffId,
    createNew: "true"
  });
  return `${DASH_APPOINTMENTS_URL}/block-time?${params.toString()}`;
}

function buildEditBlockUrl(block) {
  const params = new URLSearchParams({
    createNew: "false",
    date: block.date,
    start: block.start,
    end: block.end,
    aid: block.dashBlockId,
    staff: block.dashStaffId,
    description: block.description || ""
  });
  return `${DASH_APPOINTMENTS_URL}/block-time?${params.toString()}`;
}

function buildAppointmentsDateUrl(date) {
  const params = new URLSearchParams({ date: String(date || "") });
  return `${DASH_APPOINTMENTS_URL}?${params.toString()}`;
}

function getDashBlockIdFromUrl(value) {
  try {
    return new URL(String(value || ""), DASH_BASE_URL).searchParams.get("aid") || "";
  } catch (_error) {
    return "";
  }
}

function getDashStaffIdFromUrl(value) {
  try {
    return new URL(String(value || ""), DASH_BASE_URL).searchParams.get("staff") || "";
  } catch (_error) {
    return "";
  }
}

function getStaticNotificationTime(value) {
  const match = String(value || "").match(/\bat\s+(\d{1,2}:\d{2}\s*(?:am|pm))\s*$/i);
  return match ? match[1].replace(/\s+/g, " ").toLowerCase() : "";
}

function normalizeVisibleLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function loadBrowserRuntime() {
  const [puppeteerModule, chromiumModule] = await Promise.all([
    import("puppeteer-core"),
    import("@sparticuz/chromium")
  ]);
  return {
    puppeteer: puppeteerModule.default || puppeteerModule,
    chromium: chromiumModule.default || chromiumModule
  };
}

async function launchDashBrowser({ executablePath = "" } = {}) {
  const { puppeteer, chromium } = await loadBrowserRuntime();
  if (typeof chromium.setGraphicsMode !== "undefined") chromium.setGraphicsMode = false;
  const args = typeof puppeteer.defaultArgs === "function"
    ? await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" })
    : chromium.args;
  return puppeteer.launch({
    args,
    defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    executablePath: executablePath || await chromium.executablePath(),
    headless: "shell",
    // Warm Cloud Function instances can reuse the authenticated cookie without
    // putting it into Firestore or logs. The profile disappears with /tmp.
    userDataDir: path.join(os.tmpdir(), "roses-dash-browser-profile")
  });
}

async function prepareDashPage(page) {
  await page.setBypassServiceWorker(true);
  await page.setCacheEnabled(false);
  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-CA,en;q=0.9" });
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const handle = await page.$(selector);
    if (!handle) continue;
    const visible = await handle.evaluate(element => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    });
    if (visible) return handle;
  }
  return null;
}

async function clickButtonByText(page, labels) {
  const wanted = labels.map(label => String(label).trim().toLowerCase());
  const clicked = await page.evaluate(values => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const button = buttons.find(item => values.includes(String(item.textContent || "").trim().toLowerCase()));
    if (!button) return false;
    button.click();
    return true;
  }, wanted);
  if (!clicked) throw new Error(`Dash button was not found: ${labels.join(" / ")}`);
}

async function getSafeDashPageState(page) {
  let parsedUrl;
  try {
    parsedUrl = new URL(page.url());
  } catch (_error) {
    parsedUrl = null;
  }
  const state = await page.evaluate(({ emailSelectors, passwordSelectors, readySelectors }) => {
    const bodyText = String(document.body?.innerText || "").toLowerCase();
    const title = String(document.title || "").toLowerCase();
    const hasAny = selectors => selectors.some(selector => Boolean(document.querySelector(selector)));
    return {
      readyState: String(document.readyState || "unknown"),
      hasEmailField: hasAny(emailSelectors),
      hasPasswordField: hasAny(passwordSelectors),
      hasDashboardMarker: hasAny(readySelectors),
      iframeCount: document.querySelectorAll("iframe").length,
      challengeDetected: /just a moment|checking your browser|verify you are human|access denied/.test(`${title} ${bodyText}`)
    };
  }, {
    emailSelectors: DASH_EMAIL_SELECTORS,
    passwordSelectors: DASH_PASSWORD_SELECTORS,
    readySelectors: DASH_READY_SELECTORS
  });
  return {
    host: parsedUrl?.hostname || "unknown",
    path: parsedUrl?.pathname || "unknown",
    ...state
  };
}

function formatSafeDashPageState(state) {
  return [
    `host=${state.host}`,
    `path=${state.path}`,
    `ready=${state.readyState}`,
    `email=${state.hasEmailField ? 1 : 0}`,
    `password=${state.hasPasswordField ? 1 : 0}`,
    `dashboard=${state.hasDashboardMarker ? 1 : 0}`,
    `iframes=${Number(state.iframeCount || 0)}`,
    `challenge=${state.challengeDetected ? 1 : 0}`
  ].join(";");
}

async function throwDashPageStateError(page, stage, originalError) {
  let state = null;
  try {
    state = await getSafeDashPageState(page);
  } catch (_stateError) {
    // Preserve the original stage when the page itself can no longer be read.
  }
  const suffix = state ? `;${formatSafeDashPageState(state)}` : "";
  const error = new Error(`Dash page was not ready;stage=${stage}${suffix}`);
  error.code = state?.challengeDetected ? "DASH_BROWSER_CHALLENGE" : "DASH_PAGE_NOT_READY";
  error.cause = originalError;
  throw error;
}

async function waitForDashDashboardReady(page) {
  await page.waitForFunction(
    ({ emailSelectors, passwordSelectors, readySelectors }) => {
      const isVisible = element => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };
      const anyVisible = selectors => selectors.some(selector => isVisible(document.querySelector(selector)));
      return (
        anyVisible(readySelectors) &&
        !anyVisible(emailSelectors) &&
        !anyVisible(passwordSelectors)
      );
    },
    { timeout: DASH_LOGIN_TIMEOUT_MS },
    {
      emailSelectors: DASH_EMAIL_SELECTORS,
      passwordSelectors: DASH_PASSWORD_SELECTORS,
      readySelectors: DASH_READY_SELECTORS
    }
  );
  try {
    await page.waitForNetworkIdle({ idleTime: 750, timeout: 10000 });
  } catch (_error) {
    // Dash keeps background requests open; the visible stable dashboard is enough.
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}

async function ensureDashLogin(page, { email, password }) {
  await prepareDashPage(page);
  try {
    await page.goto(DASH_APPOINTMENTS_URL, {
      waitUntil: "domcontentloaded",
      timeout: DASH_LOGIN_TIMEOUT_MS
    });
    await page.waitForFunction(
      ({ emailSelectors, readySelectors }) => (
        emailSelectors.some(selector => Boolean(document.querySelector(selector))) ||
        readySelectors.some(selector => Boolean(document.querySelector(selector)))
      ),
      { timeout: DASH_LOGIN_TIMEOUT_MS },
      { emailSelectors: DASH_EMAIL_SELECTORS, readySelectors: DASH_READY_SELECTORS }
    );
  } catch (error) {
    await throwDashPageStateError(page, "landing", error);
  }
  const emailInput = await firstVisible(page, DASH_EMAIL_SELECTORS);
  if (!emailInput) {
    try {
      await waitForDashDashboardReady(page);
    } catch (error) {
      await throwDashPageStateError(page, "existing-session", error);
    }
    return;
  }

  const passwordInput = await firstVisible(page, DASH_PASSWORD_SELECTORS);
  if (!passwordInput) await throwDashPageStateError(page, "password-field");
  await emailInput.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await emailInput.type(String(email || ""));
  await passwordInput.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await passwordInput.type(String(password || ""));
  try {
    await clickButtonByText(page, ["log in", "login", "sign in"]);
    await waitForDashDashboardReady(page);
  } catch (error) {
    await throwDashPageStateError(page, "sign-in", error);
  }
}

async function createAuthenticatedDashPage(browser, credentials) {
  const authPage = await browser.newPage();
  try {
    await ensureDashLogin(authPage, credentials);
    return authPage;
  } catch (error) {
    if (!authPage.isClosed()) await authPage.close().catch(() => {});
    throw error;
  }
}

function isRetryableNavigationError(error) {
  return /detached frame|net::err_aborted/i.test(String(error?.message || error || ""));
}

function dashNavigationReached(actualUrl, requestedUrl) {
  try {
    const actual = new URL(String(actualUrl || ""));
    const requested = new URL(String(requestedUrl || ""));
    return (
      actual.origin === requested.origin &&
      actual.pathname === requested.pathname &&
      actual.searchParams.get("date") === requested.searchParams.get("date")
    );
  } catch (_error) {
    return false;
  }
}

async function navigateDashPage(page, url, timeout = DEFAULT_TIMEOUT_MS) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    } catch (error) {
      lastError = error;
      if (!isRetryableNavigationError(error) || page.isClosed()) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
      if (dashNavigationReached(page.url(), url)) return null;
      if (attempt === 2) throw error;
    }
  }
  throw lastError;
}

async function selectAntValue(page, selector, label, rawValue = "") {
  await page.click(selector);
  await page.waitForSelector(".ant-select-dropdown .ant-select-item-option", { timeout: 10000 });

  // Dash uses a readonly Ant Design combobox backed by a virtual list. Text
  // entry and role=option selectors do not work here, so scan the rendered
  // option window and advance the virtual holder until the exact title is in
  // view.
  await page.evaluate(() => {
    const dropdowns = Array.from(document.querySelectorAll(".ant-select-dropdown"));
    const dropdown = dropdowns.find(element => {
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    const holder = dropdown?.querySelector(".rc-virtual-list-holder");
    if (holder) {
      holder.scrollTop = 0;
      holder.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
  });

  let selected = false;
  for (let attempt = 0; attempt < 24 && !selected; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 40));
    const result = await page.evaluate(({ labelValue, raw }) => {
      const normalized = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
      const dropdowns = Array.from(document.querySelectorAll(".ant-select-dropdown"));
      const dropdown = dropdowns.find(element => {
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (!dropdown) return { selected: false, canContinue: false };
      const options = Array.from(dropdown.querySelectorAll(".ant-select-item-option"));
      const option = options.find(item => (
        normalized(item.getAttribute("title")) === normalized(labelValue) ||
        normalized(item.textContent) === normalized(labelValue) ||
        (raw && normalized(item.textContent) === normalized(raw))
      ));
      if (option) {
        option.click();
        return { selected: true, canContinue: false };
      }
      const holder = dropdown.querySelector(".rc-virtual-list-holder");
      if (!holder) return { selected: false, canContinue: false };
      const before = holder.scrollTop;
      const step = Math.max(Math.floor(holder.clientHeight * 0.75), 64);
      holder.scrollTop = Math.min(holder.scrollHeight - holder.clientHeight, before + step);
      holder.dispatchEvent(new Event("scroll", { bubbles: true }));
      return { selected: false, canContinue: holder.scrollTop > before };
    }, { labelValue: label, raw: rawValue });
    selected = result.selected === true;
    if (!selected && result.canContinue !== true) break;
  }

  if (!selected) throw new Error(`Dash option was not found: ${label}`);
  const chosen = normalizeVisibleLabel(await readSelectedAntLabel(page, selector));
  if (chosen !== normalizeVisibleLabel(label)) {
    throw new Error(`Dash selected a different option instead of: ${label}`);
  }
}

async function readSelectedAntLabel(page, selector) {
  const field = await page.$(selector);
  if (!field) return "";
  return field.evaluate(element => {
    const selected = element.closest(".ant-select")?.querySelector(".ant-select-selection-item");
    return String(selected?.getAttribute("title") || selected?.textContent || element.value || "").trim();
  });
}

async function assertSelectedDashStaff(page, block) {
  const expected = normalizeVisibleLabel(block?.dashStaffName);
  if (!expected) throw new Error("Dash staff name is missing from the requested block.");
  const actual = normalizeVisibleLabel(await readSelectedAntLabel(page, "#staff"));
  if (!actual || actual !== expected) {
    throw new Error("Dash Block Time opened with a different staff selection.");
  }
}

async function fillDescription(page, description) {
  const field = await page.$("#description");
  if (!field) throw new Error("Dash Block Time description field was not found.");
  await field.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await field.type(String(description || ""));
}

async function waitForBlockForm(page, expectedHeading) {
  await page.waitForFunction(heading => (
    Array.from(document.querySelectorAll("h1,h2,h3,h4"))
      .some(item => String(item.textContent || "").trim() === heading)
  ), { timeout: DEFAULT_TIMEOUT_MS }, expectedHeading);
}

async function openExistingBlockByDescription(page, block) {
  const dateUrl = buildAppointmentsDateUrl(block.date);
  const openDate = async () => {
    await page.goto(dateUrl, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT_MS
    });
    await page.waitForSelector('input[placeholder="Select date"]', {
      timeout: DEFAULT_TIMEOUT_MS
    });
    await page.waitForSelector(".react-grid-layout", { timeout: DEFAULT_TIMEOUT_MS });
    try {
      await page.waitForFunction(
        () => !document.querySelector(".ant-spin-spinning"),
        { timeout: 10000 }
      );
    } catch (_error) {
      // Some Dash builds leave an unrelated hidden spinner mounted. The
      // rendered grid is still the authoritative signal used below.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  };

  await openDate();
  const matchingCount = await page.$$eval("span", (items, value) => items.filter(item => (
    String(item.textContent || "").trim() === value &&
    item.closest(".react-grid-item")
  )).length, block.description);

  for (let matchIndex = 0; matchIndex < matchingCount; matchIndex += 1) {
    if (matchIndex > 0) await openDate();
    const opened = await page.evaluate(({ value, index }) => {
      const labels = Array.from(document.querySelectorAll("span")).filter(item => (
        String(item.textContent || "").trim() === value &&
        item.closest(".react-grid-item")
      ));
      const card = labels[index]?.closest(".react-grid-item");
      if (!card) return false;
      card.click();
      return true;
    }, { value: block.description, index: matchIndex });
    if (!opened) continue;
    await page.waitForFunction(
      () => location.pathname.endsWith("/appointments/block-time") && new URL(location.href).searchParams.has("aid"),
      { timeout: DEFAULT_TIMEOUT_MS }
    );
    const editUrl = page.url();
    const dashBlockId = getDashBlockIdFromUrl(editUrl);
    const dashStaffId = getDashStaffIdFromUrl(editUrl);
    const dashStaffName = await readSelectedAntLabel(page, "#staff");
    const staffMatches = !block.dashStaffId
      ? true
      : dashStaffId
        ? dashStaffId === block.dashStaffId
        : normalizeVisibleLabel(dashStaffName) === normalizeVisibleLabel(block.dashStaffName);
    if (
      dashBlockId &&
      staffMatches
    ) {
      return { dashBlockId, dashStaffId: dashStaffId || block.dashStaffId || "", editUrl };
    }
  }
  return null;
}

async function createBlock(page, block, { dryRun = false } = {}) {
  const createUrl = buildCreateBlockUrl(block);
  if (dryRun) return { dryRun: true, action: "create", createUrl, block };
  const existing = await openExistingBlockByDescription(page, block);
  if (existing) {
    return { dryRun: false, action: "adopted", ...existing };
  }
  await page.goto(createUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
  await waitForBlockForm(page, "New Block Time");
  await assertSelectedDashStaff(page, block);
  await selectAntValue(page, "#startTime", toTwelveHour(block.start), block.start);
  await selectAntValue(page, "#endTime", toTwelveHour(block.end), block.end);
  await fillDescription(page, block.description);
  await clickButtonByText(page, ["save"]);
  await page.waitForFunction(
    () => location.pathname === "/appointments",
    { timeout: DEFAULT_TIMEOUT_MS }
  );
  const created = await openExistingBlockByDescription(page, block);
  if (!created?.dashBlockId) {
    throw new Error("Dash did not expose the newly created Block Time.");
  }
  return { dryRun: false, action: "created", ...created };
}

async function updateBlock(page, link, desired, { dryRun = false } = {}) {
  const existing = {
    ...link,
    dashBlockId: link.dashBlockId,
    description: link.description || desired.description
  };
  const changedOwner = existing.date !== desired.date || existing.dashStaffId !== desired.dashStaffId;
  if (changedOwner) {
    if (dryRun) return { dryRun: true, action: "recreate", existing, desired };
    const created = await createBlock(page, desired, { dryRun: false });
    await deleteBlock(page, existing, { dryRun: false });
    return { ...created, action: "recreated" };
  }

  const located = dryRun ? null : await openExistingBlockByDescription(page, existing);
  if (!dryRun && !located) {
    return createBlock(page, desired, { dryRun: false });
  }
  const effectiveExisting = located
    ? { ...existing, ...located }
    : existing;
  const editUrl = effectiveExisting.editUrl || buildEditBlockUrl(effectiveExisting);
  if (dryRun) return { dryRun: true, action: "update", editUrl, desired };
  await page.goto(editUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
  await waitForBlockForm(page, "Edit Block Time");
  await assertSelectedDashStaff(page, desired);
  await selectAntValue(page, "#startTime", toTwelveHour(desired.start), desired.start);
  await selectAntValue(page, "#endTime", toTwelveHour(desired.end), desired.end);
  await fillDescription(page, desired.description);
  await clickButtonByText(page, ["save"]);
  await page.waitForFunction(() => location.pathname === "/appointments", { timeout: DEFAULT_TIMEOUT_MS });
  return {
    dryRun: false,
    action: "updated",
    dashBlockId: effectiveExisting.dashBlockId,
    editUrl: buildEditBlockUrl({ ...desired, dashBlockId: effectiveExisting.dashBlockId })
  };
}

async function deleteBlock(page, link, { dryRun = false } = {}) {
  const located = dryRun ? null : await openExistingBlockByDescription(page, link);
  if (!dryRun && !located) return { dryRun: false, action: "missing" };
  const effectiveLink = located ? { ...link, ...located } : link;
  const editUrl = effectiveLink.editUrl || buildEditBlockUrl(effectiveLink);
  if (dryRun) return { dryRun: true, action: "delete", editUrl };
  await page.goto(editUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
  await waitForBlockForm(page, "Edit Block Time");

  let nativeDialogHandled = false;
  page.once("dialog", async dialog => {
    nativeDialogHandled = true;
    if (dialog.type() !== "confirm" || !/delete|remove/i.test(dialog.message())) {
      await dialog.dismiss();
      return;
    }
    await dialog.accept();
  });
  await clickButtonByText(page, ["delete"]);

  if (!nativeDialogHandled) {
    try {
      await page.waitForSelector('[role="dialog"]', { timeout: 2500 });
      const confirmed = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return false;
        const buttons = Array.from(dialog.querySelectorAll("button"));
        const button = buttons.find(item => /^(delete|yes|ok|confirm)$/i.test(String(item.textContent || "").trim()));
        if (!button) return false;
        button.click();
        return true;
      });
      if (!confirmed) throw new Error("Dash deletion confirmation button was not found.");
    } catch (error) {
      if (!nativeDialogHandled) throw error;
    }
  }
  await page.waitForFunction(() => location.pathname === "/appointments", { timeout: DEFAULT_TIMEOUT_MS });
  return { dryRun: false, action: "deleted" };
}

async function readNotificationSummaries(page, limit) {
  await page.goto(DASH_APPOINTMENTS_URL, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
  await page.waitForSelector('[aria-label="bell"]', { timeout: DEFAULT_TIMEOUT_MS });
  await page.click('[aria-label="bell"]');
  try {
    await page.waitForSelector("li.notification-item-container", { timeout: 10000 });
  } catch (_error) {
    return [];
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const currentCount = await page.$$eval("li.notification-item-container", items => items.length);
    if (currentCount >= limit) break;
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const button = buttons.find(item => /^load more$/i.test(String(item.textContent || "").trim()));
      if (!button) return false;
      button.click();
      return true;
    });
    if (!clicked) break;
    try {
      await page.waitForFunction(previousCount => (
        document.querySelectorAll("li.notification-item-container").length > previousCount
      ), { timeout: 10000 }, currentCount);
    } catch (_error) {
      break;
    }
  }
  return page.$$eval("li.notification-item-container", (items, maxItems) => items.slice(0, maxItems).map((item, index) => ({
    index,
    title: String(item.querySelector("h4")?.textContent || "").trim(),
    description: String(item.querySelector(".ant-list-item-meta-description p")?.textContent || "").trim(),
    observedLabel: String(item.querySelector(".ant-list-item-meta-description span")?.textContent || "").trim()
  })), limit);
}

function buildNotificationCandidates(summaries) {
  const occurrenceByFingerprint = new Map();
  return (Array.isArray(summaries) ? summaries : []).map(summary => {
    const parsed = parseDashNotification(summary);
    if (!parsed) return null;
    const fingerprint = stableHash([
      parsed.title,
      parsed.description,
      getStaticNotificationTime(summary.observedLabel)
    ].join("|"));
    const occurrence = occurrenceByFingerprint.get(fingerprint) || 0;
    occurrenceByFingerprint.set(fingerprint, occurrence + 1);
    return {
      summary,
      parsed,
      fingerprint,
      occurrence,
      notificationKey: stableHash(`${fingerprint}|${occurrence}`)
    };
  }).filter(Boolean);
}

async function waitForDashAppointmentDetail(page) {
  await page.waitForFunction(
    () => location.pathname === "/appointments/view" && new URL(location.href).searchParams.has("aid"),
    { timeout: DEFAULT_TIMEOUT_MS }
  );
  await page.waitForFunction(
    () => {
      const bodyText = String(document.body?.innerText || "");
      const hasHeading = (
        bodyText.includes("Appointment Details") ||
        bodyText.includes("View Appointment")
      );
      const hasClient = (
        Boolean(document.querySelector('a[href*="/clients/details"]')) ||
        bodyText.includes("Search Client")
      );
      return hasHeading && hasClient && bodyText.includes("Dash Booking");
    },
    { timeout: DEFAULT_TIMEOUT_MS }
  );
}

async function parseDashAppointmentPage(page) {
  const visible = await page.evaluate(() => ({
    text: String(document.body?.innerText || ""),
    clientHint: String(
      document.querySelector('a[href*="/clients/details"]')?.textContent || ""
    ).replace(/\s+/g, " ").trim()
  }));
  return parseDashAppointmentDetail({
    text: visible.text,
    clientHint: visible.clientHint,
    url: page.url()
  });
}

async function readNewDashAppointments(page, { knownNotificationKeys = new Set(), limit = 20 } = {}) {
  const summaries = await readNotificationSummaries(page, limit);
  const candidates = buildNotificationCandidates(summaries);
  // Dash does not expose a notification id in the DOM. Identical bookings can
  // therefore share the same visible fingerprint. If one occurrence in such a
  // group is new, reopen the whole (normally one-item) group and let the stable
  // Dash appointment id provide the final deduplication in Firestore.
  const fingerprintsWithNewOccurrence = new Set(candidates
    .filter(candidate => !knownNotificationKeys.has(candidate.notificationKey))
    .map(candidate => candidate.fingerprint));
  const newItems = [];
  for (const candidate of candidates) {
    if (!fingerprintsWithNewOccurrence.has(candidate.fingerprint)) continue;

    // Reopen the notification panel for every item because viewing a detail
    // navigates away from the list and the DOM nodes are replaced.
    const currentSummaries = await readNotificationSummaries(
      page,
      Math.max(10, Number(candidate.summary.index) + 1)
    );
    const currentCandidate = buildNotificationCandidates(currentSummaries).find(item => (
      item.fingerprint === candidate.fingerprint &&
      item.occurrence === candidate.occurrence
    ));
    if (!currentCandidate) continue;
    const rows = await page.$$("li.notification-item-container");
    if (!rows[currentCandidate.summary.index]) continue;
    await rows[currentCandidate.summary.index].click();
    await waitForDashAppointmentDetail(page);
    const detail = await parseDashAppointmentPage(page);
    newItems.push({
      notificationKey: candidate.notificationKey,
      notificationFingerprint: candidate.fingerprint,
      notification: candidate.parsed,
      kind: candidate.parsed.kind,
      detail
    });
  }
  return newItems;
}

function addDateDays(dateKey, days) {
  const [year, month, day] = String(dateKey || "").split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12));
  if (Number.isNaN(date.getTime())) return "";
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

async function waitForDashCalendar(page) {
  await page.waitForSelector('input[placeholder="Select date"]', { timeout: DEFAULT_TIMEOUT_MS });
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("h4")).some(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 100 && rect.height > 0;
    }),
    { timeout: DEFAULT_TIMEOUT_MS }
  );
  try {
    await page.waitForFunction(
      () => !document.querySelector(".ant-spin-spinning"),
      { timeout: 10000 }
    );
  } catch (_error) {
    // Some Dash releases keep an unrelated hidden spinner mounted.
  }
  await new Promise(resolve => setTimeout(resolve, 250));
}

async function collectDashCalendarCards(page, date) {
  return page.evaluate(currentDate => {
    const staffHeadings = Array.from(document.querySelectorAll("h4"))
      .map(element => ({
        name: String(element.textContent || "").replace(/\s+/g, " ").trim(),
        rect: element.getBoundingClientRect()
      }))
      .filter(item => item.name && item.rect.width > 100 && item.rect.height > 0)
      .sort((left, right) => left.rect.x - right.rect.x);
    const cards = Array.from(document.querySelectorAll(".react-grid-item"));
    return cards.map((element, index) => {
      const text = String(element.innerText || "").replace(/\r/g, "").trim();
      const style = String(element.getAttribute("style") || "");
      const transform = style.match(/translate\(\s*([\d.-]+)px\s*,\s*([\d.-]+)px\s*\)/i);
      const heightMatch = style.match(/height:\s*([\d.-]+)px/i);
      const x = Number(transform?.[1]);
      const y = Number(transform?.[2]);
      const height = Number(heightMatch?.[1]);
      const staffIndex = Number.isFinite(x) ? Math.max(0, Math.round(x / 143)) : -1;
      const startMinutes = Number.isFinite(y) ? 6 * 60 + Math.round(y / 2) : null;
      const endMinutes = Number.isFinite(height) && Number.isFinite(startMinutes)
        ? startMinutes + Math.round(height / 2)
        : null;
      const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
      const isBlock = /^Blocked Time$/i.test(lines[0] || "");
      return {
        index,
        cardKey: `${style}|${text}`,
        date: currentDate,
        text,
        lines,
        isBlock,
        dashStaffName: staffHeadings[staffIndex]?.name || "",
        startMinutes,
        endMinutes,
        description: isBlock ? String(lines.slice(2).join(" ") || "").trim() : ""
      };
    });
  }, date);
}

async function readDashCalendarCards(page, date) {
  await navigateDashPage(page, buildAppointmentsDateUrl(date));
  await waitForDashCalendar(page);
  return collectDashCalendarCards(page, date);
}

function buildDashAuditAppointmentFromCard(card) {
  const startMinutes = Number(card?.startMinutes);
  const endMinutes = Number(card?.endMinutes);
  const start = Math.round((startMinutes - 8 * 60) / 15);
  const duration = Math.round((endMinutes - startMinutes) / 15);
  const lines = Array.isArray(card?.lines) ? card.lines.map(line => String(line || "").trim()).filter(Boolean) : [];
  if (
    card?.isBlock === true || !String(card?.date || "") || !String(card?.dashStaffName || "").trim() ||
    !Number.isInteger(start) || start < 0 || !Number.isInteger(duration) || duration < 1 || lines.length < 1
  ) return null;
  return {
    dashBookingId: `audit_${stableHash(String(card.cardKey || "")).slice(0, 40)}`,
    client: lines[0],
    date: String(card.date),
    start,
    duration,
    service: String(lines.slice(1).join(" ") || "Dash Booking appointment"),
    staffName: String(card.dashStaffName).trim(),
    sourceUrl: buildAppointmentsDateUrl(card.date),
    dashStatus: "confirmed",
    canceledByClient: false,
    cancellationReason: "",
    previousDate: "",
    previousTime: "",
    rescheduledDate: "",
    rescheduledTime: "",
    auditSummaryOnly: true
  };
}

async function readDashCalendarRangeForAudit(page, { startDate, endDate } = {}) {
  const date = String(startDate || "");
  const last = String(endDate || "");
  if (!date || date !== last) {
    throw new Error("The experimental Dash audit currently supports one calendar day only.");
  }

  // The Cloud Functions Chromium build supports the single page created for
  // authentication, but not Target.createTarget for a second tab. Today is
  // already the default Dash calendar after sign-in, so read that page in
  // place without another navigation or browser target.
  await waitForDashCalendar(page);
  const cards = await collectDashCalendarCards(page, date);
  const blocks = cards.filter(item => item.isBlock).map(item => ({
    date,
    start: minutesToTime(item.startMinutes),
    end: minutesToTime(item.endMinutes),
    dashStaffName: item.dashStaffName,
    description: item.description,
    observedKey: stableHash(item.cardKey)
  })).filter(item => item.start && item.end && item.dashStaffName);
  const appointments = cards
    .map(buildDashAuditAppointmentFromCard)
    .filter(Boolean);
  return {
    startDate: date,
    endDate: date,
    appointments,
    blocks,
    days: [{ date, appointments: appointments.length, blocks: blocks.length, cards: cards.length }]
  };
}

async function openDashCalendarCard(page, date, cardKey) {
  const cards = await readDashCalendarCards(page, date);
  const candidate = cards.find(item => item.cardKey === cardKey);
  if (!candidate) return null;
  const clicked = await page.evaluate(key => {
    const element = Array.from(document.querySelectorAll(".react-grid-item")).find(item => {
      const style = String(item.getAttribute("style") || "");
      const text = String(item.innerText || "").replace(/\r/g, "").trim();
      return `${style}|${text}` === key;
    });
    if (!element) return false;
    element.click();
    return true;
  }, cardKey);
  if (!clicked) return null;
  await waitForDashAppointmentDetail(page);
  return parseDashAppointmentPage(page);
}

async function readDashCalendarDay(page, date) {
  const cards = await readDashCalendarCards(page, date);
  const blocks = cards.filter(item => item.isBlock).map(item => ({
    date,
    start: minutesToTime(item.startMinutes),
    end: minutesToTime(item.endMinutes),
    dashStaffName: item.dashStaffName,
    description: item.description,
    observedKey: stableHash(item.cardKey)
  })).filter(item => item.start && item.end && item.dashStaffName);
  const appointments = [];
  const seen = new Set();
  for (const card of cards.filter(item => !item.isBlock)) {
    const detail = await openDashCalendarCard(page, date, card.cardKey);
    if (!detail?.dashBookingId || seen.has(detail.dashBookingId)) continue;
    seen.add(detail.dashBookingId);
    appointments.push(detail);
  }
  return { date, appointments, blocks, cardCount: cards.length };
}

async function readDashCalendarRange(page, { startDate, endDate } = {}) {
  const appointments = [];
  const blocks = [];
  const days = [];
  let date = String(startDate || "");
  const last = String(endDate || "");
  for (let guard = 0; date && last && date <= last && guard < 62; guard += 1) {
    const day = await readDashCalendarDay(page, date);
    appointments.push(...day.appointments);
    blocks.push(...day.blocks);
    days.push({
      date,
      appointments: day.appointments.length,
      blocks: day.blocks.length,
      cards: day.cardCount
    });
    date = addDateDays(date, 1);
  }
  return { startDate, endDate, appointments, blocks, days };
}

function createDashBrowserClient(page, options = {}) {
  const dryRun = options.dryRun === true;
  const auditSummaryOnly = options.auditSummaryOnly === true;
  return {
    createBlock: block => createBlock(page, block, { dryRun }),
    updateBlock: (link, block) => updateBlock(page, link, block, { dryRun }),
    deleteBlock: link => deleteBlock(page, link, { dryRun }),
    readNewDashAppointments: input => readNewDashAppointments(page, input),
    readDashEvents: input => readNewDashAppointments(page, input),
    readCalendarRange: input => auditSummaryOnly
      ? readDashCalendarRangeForAudit(page, input)
      : readDashCalendarRange(page, input)
  };
}

module.exports = {
  DASH_APPOINTMENTS_URL,
  DASH_BASE_URL,
  buildNotificationCandidates,
  buildCreateBlockUrl,
  buildEditBlockUrl,
  buildAppointmentsDateUrl,
  buildDashAuditAppointmentFromCard,
  createBlock,
  createAuthenticatedDashPage,
  createDashBrowserClient,
  dashNavigationReached,
  deleteBlock,
  ensureDashLogin,
  formatSafeDashPageState,
  getSafeDashPageState,
  getDashBlockIdFromUrl,
  getDashStaffIdFromUrl,
  getStaticNotificationTime,
  isRetryableNavigationError,
  launchDashBrowser,
  navigateDashPage,
  prepareDashPage,
  readDashCalendarCards,
  readDashCalendarDay,
  readDashCalendarRange,
  readDashCalendarRangeForAudit,
  readNewDashAppointments,
  readSelectedAntLabel,
  selectAntValue,
  toTwelveHour,
  updateBlock
};
