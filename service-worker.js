const ALARM_PREFIX = "local-tab-keepalive:";
const STATE_KEY = "enabledTabs";

const MIN_INTERVAL_MS = 35_000;
const MAX_INTERVAL_MS = 55_000;

function alarmName(tabId) {
  return `${ALARM_PREFIX}${tabId}`;
}

function parseTabId(name) {
  if (!name.startsWith(ALARM_PREFIX)) {
    return null;
  }

  const tabId = Number(name.slice(ALARM_PREFIX.length));
  return Number.isInteger(tabId) ? tabId : null;
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function readState() {
  const result = await chrome.storage.session.get(STATE_KEY);
  return result[STATE_KEY] ?? {};
}

async function writeState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

async function setBadge(tabId, enabled) {
  await chrome.action.setBadgeText({
    tabId,
    text: enabled ? "ON" : ""
  });

  if (enabled) {
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: "#2E7D32"
    });
  }
}

async function scheduleNext(tabId) {
  const delayMs =
    MIN_INTERVAL_MS +
    Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS + 1));

  await chrome.alarms.create(alarmName(tabId), {
    when: Date.now() + delayMs
  });
}

async function pulseTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        const width = Math.max(window.innerWidth, 1);
        const height = Math.max(window.innerHeight, 1);

        const x = Math.floor(width * (0.2 + Math.random() * 0.6));
        const y = Math.floor(height * (0.2 + Math.random() * 0.6));
        const target =
          document.elementFromPoint(x, y) ||
          document.body ||
          document.documentElement;

        const eventInit = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          screenX: window.screenX + x,
          screenY: window.screenY + y,
          buttons: 0
        };

        try {
          target.dispatchEvent(
            new PointerEvent("pointermove", {
              ...eventInit,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true
            })
          );
        } catch {
          // PointerEvent may not exist in some environments.
        }

        target.dispatchEvent(new MouseEvent("mousemove", eventInit));

        const originalX = window.scrollX;
        const originalY = window.scrollY;
        const documentHeight = Math.max(
          document.documentElement?.scrollHeight ?? 0,
          document.body?.scrollHeight ?? 0
        );
        const maxY = Math.max(documentHeight - window.innerHeight, 0);

        if (maxY > 0) {
          const magnitude = 24 + Math.floor(Math.random() * 73);
          let delta = Math.random() < 0.5 ? magnitude : -magnitude;

          if (originalY <= 0) {
            delta = magnitude;
          } else if (originalY >= maxY) {
            delta = -magnitude;
          }

          window.scrollBy({
            top: delta,
            left: 0,
            behavior: "instant"
          });

          await sleep(180 + Math.floor(Math.random() * 220));

          window.scrollTo({
            top: originalY,
            left: originalX,
            behavior: "instant"
          });
        }

        return {
          at: Date.now(),
          url: location.href
        };
      }
    });

    return results?.[0]?.result ?? null;
  } catch (error) {
    console.debug("Keepalive pulse skipped:", error?.message ?? error);
    return null;
  }
}

async function enableTab(tab) {
  if (!tab?.id || !tab.url) {
    throw new Error("No usable active tab.");
  }

  const parsedUrl = new URL(tab.url);
  if (!/^https?:$/.test(parsedUrl.protocol)) {
    throw new Error("Only normal HTTP/HTTPS pages are supported.");
  }

  const state = await readState();
  state[tab.id] = {
    origin: parsedUrl.origin,
    enabledAt: Date.now(),
    lastPulseAt: null
  };
  await writeState(state);

  await setBadge(tab.id, true);

  const pulse = await pulseTab(tab.id);
  if (pulse) {
    const updated = await readState();
    if (updated[tab.id]) {
      updated[tab.id].lastPulseAt = pulse.at;
      await writeState(updated);
    }
  }

  await scheduleNext(tab.id);
}

async function disableTab(tabId) {
  const state = await readState();
  delete state[tabId];
  await writeState(state);

  await chrome.alarms.clear(alarmName(tabId));

  try {
    await setBadge(tabId, false);
  } catch {
    // Tab may already have been closed.
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "get-status") {
      const state = await readState();
      sendResponse({
        ok: true,
        enabled: Boolean(state[message.tabId]),
        info: state[message.tabId] ?? null
      });
      return;
    }

    if (message?.type === "set-enabled") {
      const tab = await chrome.tabs.get(message.tabId);

      if (message.enabled) {
        await enableTab(tab);
      } else {
        await disableTab(message.tabId);
      }

      const state = await readState();
      sendResponse({
        ok: true,
        enabled: Boolean(state[message.tabId]),
        info: state[message.tabId] ?? null
      });
      return;
    }

    sendResponse({ ok: false, error: "Unknown request." });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error?.message ?? String(error)
    });
  });

  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const tabId = parseTabId(alarm.name);
  if (tabId === null) {
    return;
  }

  const state = await readState();
  const entry = state[tabId];

  if (!entry) {
    await chrome.alarms.clear(alarm.name);
    return;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    const currentOrigin = getOrigin(tab.url);

    if (!currentOrigin || currentOrigin !== entry.origin) {
      await disableTab(tabId);
      return;
    }

    const pulse = await pulseTab(tabId);

    if (pulse) {
      const updated = await readState();
      if (updated[tabId]) {
        updated[tabId].lastPulseAt = pulse.at;
        await writeState(updated);
      }
    }

    await setBadge(tabId, true);
    await scheduleNext(tabId);
  } catch {
    await disableTab(tabId);
  }
});

// Chrome can reset per-tab action state during navigation/reload.
// Restore the badge whenever an enabled tab reloads or navigates
// within the same origin. Disable immediately if it changes origin.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const state = await readState();
  const entry = state[tabId];

  if (!entry) {
    return;
  }

  const url = changeInfo.url ?? tab.url;
  const currentOrigin = getOrigin(url);

  if (currentOrigin && currentOrigin !== entry.origin) {
    await disableTab(tabId);
    return;
  }

  if (
    changeInfo.status === "loading" ||
    changeInfo.status === "complete" ||
    Boolean(changeInfo.url)
  ) {
    try {
      await setBadge(tabId, true);
    } catch {
      // Ignore transient tab/navigation races.
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await disableTab(tabId);
});
