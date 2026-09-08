const enabledInput = document.getElementById("enabled");
const siteEl = document.getElementById("site");
const activePanel = document.getElementById("active-panel");
const disabledStatus = document.getElementById("disabled-status");

const assessmentEl = document.getElementById("assessment");
const statusEl = document.getElementById("status");

const idleStatusEl = document.getElementById("idle-status");
const inputStatusEl = document.getElementById("input-status");
const domStatusEl = document.getElementById("dom-status");
const fetchStatusEl = document.getElementById("fetch-status");
const replayStatusEl = document.getElementById("replay-status");
const renewalStatusEl = document.getElementById("renewal-status");
const expiryStatusEl = document.getElementById("expiry-status");

const idleEmulationInput = document.getElementById("idle-emulation");
const browserInputInput = document.getElementById("browser-input");
const domActivityInput = document.getElementById("dom-activity");
const pageFetchInput = document.getElementById("page-fetch");
const replayXhrInput = document.getElementById("replay-xhr");
const periodicReloadInput = document.getElementById("periodic-reload");
const reloadMinutesSelect = document.getElementById("reload-minutes");
const preventSleepInput = document.getElementById("prevent-sleep");
const pulseNowButton = document.getElementById("pulse-now");

let currentTabId = null;
let savingOptions = false;

function formatTime(timestamp) {
  return timestamp
    ? new Date(timestamp).toLocaleTimeString()
    : "not yet";
}

function formatEpochSeconds(seconds) {
  if (!seconds) {
    return "None detected";
  }

  return new Date(seconds * 1000).toLocaleString();
}

function stateLabel(value) {
  if (value === true) {
    return "OK";
  }

  if (value === false) {
    return "Failed";
  }

  return "—";
}

function render(result) {
  const enabled = Boolean(result.enabled);
  const info = result.info ?? {};
  const options = info.options ?? {};

  enabledInput.checked = enabled;
  activePanel.hidden = !enabled;
  disabledStatus.hidden = enabled;

  if (!enabled) {
    return;
  }

  assessmentEl.textContent =
    result.assessment?.label ?? "Collecting session evidence";

  statusEl.textContent =
    `Last pulse: ${formatTime(info.lastPulseAt)} · Pulses: ${info.pulseCount ?? 0}`;

  idleStatusEl.textContent = stateLabel(info.idleEmulationOk);
  inputStatusEl.textContent = stateLabel(info.browserInputOk);
  domStatusEl.textContent = stateLabel(info.domActivityOk);

  if (!info.pageFetchAttempted) {
    fetchStatusEl.textContent = "—";
  } else if (info.pageFetchStatus) {
    fetchStatusEl.textContent = `HTTP ${info.pageFetchStatus}`;
  } else {
    fetchStatusEl.textContent = info.pageFetchOk ? "OK" : "Failed";
  }

  replayStatusEl.textContent =
    info.replayAttempted
      ? `${info.replaySucceeded ?? 0}/${info.replayAttempted}`
      : "—";

  const evidence = info.renewalEvidence ?? [];
  if (evidence.length > 0) {
    const strong = evidence.some((item) =>
      ["auth-cookie", "auth-cookie-jwt", "storage-jwt"].includes(item.kind)
    );

    renewalStatusEl.textContent =
      strong ? "Strong evidence" : "Cookie renewed";
  } else {
    renewalStatusEl.textContent = "None yet";
  }

  expiryStatusEl.textContent =
    info.fixedExpiryAt
      ? formatEpochSeconds(info.fixedExpiryAt)
      : "None detected";

  idleEmulationInput.checked = options.idleEmulation !== false;
  browserInputInput.checked = options.browserInput !== false;
  domActivityInput.checked = options.domActivity !== false;
  pageFetchInput.checked = options.currentPageFetch !== false;
  replayXhrInput.checked = Boolean(options.replaySafeXhr);
  periodicReloadInput.checked = Boolean(options.periodicReload);
  reloadMinutesSelect.value =
    String(options.reloadEveryMinutes ?? 10);
  preventSleepInput.checked = Boolean(options.preventSleep);
}

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);

  if (!result?.ok) {
    throw new Error(result?.error ?? "Extension request failed.");
  }

  return result;
}

async function initialize() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id) {
    throw new Error("No active tab.");
  }

  currentTabId = tab.id;

  try {
    siteEl.textContent =
      tab.url ? new URL(tab.url).hostname : "Current tab";
  } catch {
    siteEl.textContent = "Current tab";
  }

  render(
    await request({
      type: "get-status",
      tabId: currentTabId
    })
  );
}

enabledInput.addEventListener("change", async () => {
  if (currentTabId === null) {
    return;
  }

  const requested = enabledInput.checked;
  enabledInput.disabled = true;

  try {
    render(
      await request({
        type: "set-enabled",
        tabId: currentTabId,
        enabled: requested
      })
    );
  } catch (error) {
    enabledInput.checked = !requested;
    disabledStatus.textContent =
      error?.message ?? String(error);
  } finally {
    enabledInput.disabled = false;
  }
});

async function saveOptions() {
  if (
    savingOptions ||
    currentTabId === null ||
    !enabledInput.checked
  ) {
    return;
  }

  savingOptions = true;

  try {
    const options = {
      idleEmulation: idleEmulationInput.checked,
      browserInput: browserInputInput.checked,
      domActivity: domActivityInput.checked,
      currentPageFetch: pageFetchInput.checked,
      replaySafeXhr: replayXhrInput.checked,
      periodicReload: periodicReloadInput.checked,
      reloadEveryMinutes: Number(reloadMinutesSelect.value),
      preventSleep: preventSleepInput.checked
    };

    render(
      await request({
        type: "set-options",
        tabId: currentTabId,
        options
      })
    );
  } finally {
    savingOptions = false;
  }
}

[
  idleEmulationInput,
  browserInputInput,
  domActivityInput,
  pageFetchInput,
  replayXhrInput,
  periodicReloadInput,
  reloadMinutesSelect,
  preventSleepInput
].forEach((element) => {
  element.addEventListener("change", () => {
    saveOptions().catch((error) => {
      statusEl.textContent =
        error?.message ?? String(error);
    });
  });
});

pulseNowButton.addEventListener("click", async () => {
  if (currentTabId === null) {
    return;
  }

  pulseNowButton.disabled = true;
  statusEl.textContent = "Running keepalive…";

  try {
    render(
      await request({
        type: "pulse-now",
        tabId: currentTabId
      })
    );
  } catch (error) {
    statusEl.textContent =
      error?.message ?? String(error);
  } finally {
    pulseNowButton.disabled = false;
  }
});

initialize().catch((error) => {
  enabledInput.disabled = true;
  disabledStatus.textContent =
    error?.message ?? String(error);
});
