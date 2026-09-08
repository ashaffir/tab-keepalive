const enabledInput = document.getElementById("enabled");
const statusEl = document.getElementById("status");
const siteEl = document.getElementById("site");

let currentTabId = null;

function formatTime(timestamp) {
  if (!timestamp) {
    return "not yet";
  }

  return new Date(timestamp).toLocaleTimeString();
}

function render(result) {
  enabledInput.checked = Boolean(result.enabled);

  if (result.enabled) {
    statusEl.textContent =
      `Enabled. Last activity: ${formatTime(result.info?.lastPulseAt)}.`;
  } else {
    statusEl.textContent = "Disabled for this tab.";
  }
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
    siteEl.textContent = tab.url ? new URL(tab.url).hostname : "Current tab";
  } catch {
    siteEl.textContent = "Current tab";
  }

  const result = await chrome.runtime.sendMessage({
    type: "get-status",
    tabId: currentTabId
  });

  if (!result?.ok) {
    throw new Error(result?.error ?? "Unable to read status.");
  }

  render(result);
}

enabledInput.addEventListener("change", async () => {
  if (currentTabId === null) {
    return;
  }

  enabledInput.disabled = true;
  statusEl.textContent = enabledInput.checked ? "Enabling…" : "Disabling…";

  try {
    const result = await chrome.runtime.sendMessage({
      type: "set-enabled",
      tabId: currentTabId,
      enabled: enabledInput.checked
    });

    if (!result?.ok) {
      throw new Error(result?.error ?? "Unable to update status.");
    }

    render(result);
  } catch (error) {
    enabledInput.checked = !enabledInput.checked;
    statusEl.textContent = error?.message ?? String(error);
  } finally {
    enabledInput.disabled = false;
  }
});

initialize().catch((error) => {
  enabledInput.disabled = true;
  statusEl.textContent = error?.message ?? String(error);
});
