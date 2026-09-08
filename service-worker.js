const STATE_KEY = "enabledTabs";
const HISTORY_KEY = "originExpiryHistory";
const ALARM_PREFIX = "local-tab-keepalive:";

const DEBUGGER_VERSION = "1.3";
const MIN_INTERVAL_MS = 30_000;
const MAX_INTERVAL_MS = 45_000;

const DEFAULT_OPTIONS = Object.freeze({
  idleEmulation: true,
  browserInput: true,
  domActivity: true,
  currentPageFetch: true,
  replaySafeXhr: false,
  periodicReload: false,
  reloadEveryMinutes: 10,
  preventSleep: false
});

const LOGIN_RE =
  /(?:^|\/)(?:login|log-in|signin|sign-in|session-expired|reauth)(?:\/|$)/i;

const UNSAFE_GET_RE =
  /(?:logout|log-out|signout|sign-out|delete|remove|revoke|terminate|unsubscribe|checkout|purchase|payment|pay|confirm|reset|destroy|disable)/i;

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

function httpOrigin(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

function isLoginLike(url) {
  try {
    const parsed = new URL(url);
    return LOGIN_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isSafeReplayUrl(url, origin) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin) {
      return false;
    }

    const text = `${parsed.pathname}${parsed.search}`;
    return !UNSAFE_GET_RE.test(text);
  } catch {
    return false;
  }
}

function mergedOptions(options) {
  return {
    ...DEFAULT_OPTIONS,
    ...(options ?? {})
  };
}

function decodeBase64UrlJson(part) {
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function jwtMetadata(value) {
  if (typeof value !== "string") {
    return null;
  }

  const parts = value.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const payload = decodeBase64UrlJson(parts[1]);
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const exp = Number(payload.exp);
  const iat = Number(payload.iat);

  if (!Number.isFinite(exp)) {
    return null;
  }

  return {
    exp,
    iat: Number.isFinite(iat) ? iat : null
  };
}

async function readState() {
  const result = await chrome.storage.session.get(STATE_KEY);
  return result[STATE_KEY] ?? {};
}

async function writeState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

async function getEntry(tabId) {
  const state = await readState();
  return state[tabId] ?? null;
}

async function updateEntry(tabId, patch) {
  const state = await readState();
  if (!state[tabId]) {
    return null;
  }

  state[tabId] = {
    ...state[tabId],
    ...patch
  };

  await writeState(state);
  return state[tabId];
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
  const delay =
    MIN_INTERVAL_MS +
    Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS + 1));

  await chrome.alarms.create(alarmName(tabId), {
    when: Date.now() + delay
  });
}

async function syncPowerState() {
  const state = await readState();

  const shouldStayAwake = Object.values(state).some(
    (entry) => mergedOptions(entry.options).preventSleep
  );

  if (shouldStayAwake) {
    chrome.power.requestKeepAwake("system");
  } else {
    chrome.power.releaseKeepAwake();
  }
}

async function ensureDebugger(tabId) {
  const target = { tabId };

  try {
    await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: "void 0"
    });
    return true;
  } catch {
    // Not attached by this extension yet.
  }

  try {
    await chrome.debugger.attach(target, DEBUGGER_VERSION);
    await chrome.debugger.sendCommand(target, "Network.enable", {});
    return true;
  } catch {
    return false;
  }
}

async function clearDebuggerEmulation(tabId) {
  const target = { tabId };

  try {
    await chrome.debugger.sendCommand(
      target,
      "Emulation.clearIdleOverride",
      {}
    );
  } catch {
    // Optional/experimental command may not be available.
  }

  try {
    await chrome.debugger.sendCommand(
      target,
      "Emulation.setFocusEmulationEnabled",
      { enabled: false }
    );
  } catch {
    // Optional command may not be available.
  }
}

async function detachDebugger(tabId) {
  await clearDebuggerEmulation(tabId);

  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached or tab no longer exists.
  }
}

async function debuggerActivity(tabId, options) {
  if (!options.idleEmulation && !options.browserInput && !options.replaySafeXhr) {
    return {
      attached: false,
      idleOk: null,
      inputOk: null,
      details: []
    };
  }

  const attached = await ensureDebugger(tabId);
  if (!attached) {
    return {
      attached: false,
      idleOk: false,
      inputOk: false,
      details: ["Chrome debugger could not attach"]
    };
  }

  const target = { tabId };
  const details = [];
  let idleOk = null;
  let inputOk = null;

  if (options.idleEmulation) {
    let idleOverrideOk = false;
    let focusOverrideOk = false;

    try {
      await chrome.debugger.sendCommand(
        target,
        "Emulation.setIdleOverride",
        {
          isUserActive: true,
          isScreenUnlocked: true
        }
      );
      idleOverrideOk = true;
    } catch (error) {
      details.push(`Idle override: ${error?.message ?? String(error)}`);
    }

    try {
      await chrome.debugger.sendCommand(
        target,
        "Emulation.setFocusEmulationEnabled",
        { enabled: true }
      );
      focusOverrideOk = true;
    } catch (error) {
      details.push(`Focus emulation: ${error?.message ?? String(error)}`);
    }

    idleOk = idleOverrideOk || focusOverrideOk;
  }

  if (options.browserInput) {
    try {
      const result = await chrome.debugger.sendCommand(
        target,
        "Runtime.evaluate",
        {
          expression: `({
            width: Math.max(window.innerWidth, 1),
            height: Math.max(window.innerHeight, 1)
          })`,
          returnByValue: true
        }
      );

      const viewport = result?.result?.value ?? {};
      const width = Number(viewport.width) || 800;
      const height = Number(viewport.height) || 600;

      const x = Math.max(
        1,
        Math.floor(width * (0.25 + Math.random() * 0.5))
      );
      const y = Math.max(
        1,
        Math.floor(height * (0.25 + Math.random() * 0.5))
      );

      await chrome.debugger.sendCommand(
        target,
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x,
          y,
          button: "none",
          buttons: 0,
          pointerType: "mouse"
        }
      );

      await chrome.debugger.sendCommand(
        target,
        "Input.dispatchKeyEvent",
        {
          type: "rawKeyDown",
          key: "Shift",
          code: "ShiftLeft",
          windowsVirtualKeyCode: 16,
          nativeVirtualKeyCode: 16,
          modifiers: 8
        }
      );

      await chrome.debugger.sendCommand(
        target,
        "Input.dispatchKeyEvent",
        {
          type: "keyUp",
          key: "Shift",
          code: "ShiftLeft",
          windowsVirtualKeyCode: 16,
          nativeVirtualKeyCode: 16,
          modifiers: 0
        }
      );

      inputOk = true;
    } catch (error) {
      inputOk = false;
      details.push(`Input: ${error?.message ?? String(error)}`);
    }
  }

  return {
    attached: true,
    idleOk,
    inputOk,
    details
  };
}

async function pageActivity(tabId, options) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [{
        domActivity: options.domActivity,
        currentPageFetch: options.currentPageFetch
      }],
      func: async (opts) => {
        const sleep = (ms) =>
          new Promise((resolve) => setTimeout(resolve, ms));

        function decodeJwt(value) {
          try {
            if (typeof value !== "string") {
              return null;
            }

            const parts = value.split(".");
            if (parts.length !== 3) {
              return null;
            }

            const normalized = parts[1]
              .replace(/-/g, "+")
              .replace(/_/g, "/");

            const padded =
              normalized +
              "=".repeat((4 - (normalized.length % 4)) % 4);

            const payload = JSON.parse(atob(padded));
            const exp = Number(payload.exp);
            const iat = Number(payload.iat);

            if (!Number.isFinite(exp)) {
              return null;
            }

            return {
              exp,
              iat: Number.isFinite(iat) ? iat : null
            };
          } catch {
            return null;
          }
        }

        function scanStringForJwt(value, source, key, path, out, depth = 0) {
          if (out.length >= 12 || depth > 3 || typeof value !== "string") {
            return;
          }

          const direct = decodeJwt(value);
          if (direct) {
            out.push({
              source,
              key,
              path,
              exp: direct.exp,
              iat: direct.iat
            });
            return;
          }

          const trimmed = value.trim();
          if (!trimmed || !["{", "["].includes(trimmed[0])) {
            return;
          }

          try {
            const parsed = JSON.parse(trimmed);

            const visit = (node, nodePath, level) => {
              if (out.length >= 12 || level > 3) {
                return;
              }

              if (typeof node === "string") {
                const meta = decodeJwt(node);
                if (meta) {
                  out.push({
                    source,
                    key,
                    path: nodePath,
                    exp: meta.exp,
                    iat: meta.iat
                  });
                }
                return;
              }

              if (Array.isArray(node)) {
                node.slice(0, 20).forEach((item, index) =>
                  visit(item, `${nodePath}[${index}]`, level + 1)
                );
                return;
              }

              if (node && typeof node === "object") {
                Object.entries(node)
                  .slice(0, 30)
                  .forEach(([childKey, childValue]) =>
                    visit(
                      childValue,
                      nodePath ? `${nodePath}.${childKey}` : childKey,
                      level + 1
                    )
                  );
              }
            };

            visit(parsed, path, depth + 1);
          } catch {
            // Not JSON.
          }
        }

        function scanStorage(storage, source) {
          const out = [];

          try {
            for (let i = 0; i < storage.length && out.length < 12; i += 1) {
              const key = storage.key(i);
              if (!key) {
                continue;
              }

              const value = storage.getItem(key);
              scanStringForJwt(value, source, key, "", out);
            }
          } catch {
            // Storage can be inaccessible under some page policies.
          }

          return out;
        }

        const report = {
          domActivityOk: null,
          fetchAttempted: false,
          fetchOk: null,
          fetchStatus: null,
          fetchRedirected: false,
          fetchFinalUrl: null,
          pageUrl: location.href,
          pageLoginLike:
            /(?:^|\/)(?:login|log-in|signin|sign-in|session-expired|reauth)(?:\/|$)/i
              .test(location.pathname),
          documentVisibility: document.visibilityState,
          documentHasFocus: document.hasFocus(),
          jwtMetadata: [],
          error: null
        };

        if (opts.domActivity) {
          try {
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
              // PointerEvent is optional.
            }

            target.dispatchEvent(new MouseEvent("mousemove", eventInit));

            window.dispatchEvent(
              new FocusEvent("focus", {
                bubbles: false,
                cancelable: false
              })
            );

            const originalX = window.scrollX;
            const originalY = window.scrollY;

            const documentHeight = Math.max(
              document.documentElement?.scrollHeight ?? 0,
              document.body?.scrollHeight ?? 0
            );

            const maxY = Math.max(
              documentHeight - window.innerHeight,
              0
            );

            if (maxY > 0) {
              const magnitude = 12 + Math.floor(Math.random() * 25);
              let delta =
                Math.random() < 0.5 ? magnitude : -magnitude;

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

              await sleep(100 + Math.floor(Math.random() * 100));

              window.scrollTo({
                top: originalY,
                left: originalX,
                behavior: "instant"
              });
            }

            report.domActivityOk = true;
          } catch (error) {
            report.domActivityOk = false;
            report.error =
              `DOM: ${error?.message ?? String(error)}`;
          }
        }

        if (opts.currentPageFetch) {
          try {
            report.fetchAttempted = true;

            const response = await fetch(location.href, {
              method: "GET",
              credentials: "include",
              cache: "no-store",
              redirect: "follow",
              keepalive: true
            });

            report.fetchOk = response.ok;
            report.fetchStatus = response.status;
            report.fetchRedirected = response.redirected;
            report.fetchFinalUrl = response.url;

            try {
              await response.body?.cancel();
            } catch {
              // Not all responses expose a cancelable stream.
            }
          } catch (error) {
            report.fetchOk = false;

            const message =
              `Fetch: ${error?.message ?? String(error)}`;

            report.error = report.error
              ? `${report.error}; ${message}`
              : message;
          }
        }

        // Allow any cookie/token refresh triggered by the request to settle.
        await sleep(150);

        report.jwtMetadata = [
          ...scanStorage(localStorage, "localStorage"),
          ...scanStorage(sessionStorage, "sessionStorage")
        ];

        return report;
      }
    });

    return results?.[0]?.result ?? {
      domActivityOk: false,
      fetchAttempted: false,
      fetchOk: false,
      fetchStatus: null,
      fetchRedirected: false,
      fetchFinalUrl: null,
      pageUrl: null,
      pageLoginLike: false,
      documentVisibility: null,
      documentHasFocus: null,
      jwtMetadata: [],
      error: "No result returned by page"
    };
  } catch (error) {
    return {
      domActivityOk: false,
      fetchAttempted: false,
      fetchOk: false,
      fetchStatus: null,
      fetchRedirected: false,
      fetchFinalUrl: null,
      pageUrl: null,
      pageLoginLike: false,
      documentVisibility: null,
      documentHasFocus: null,
      jwtMetadata: [],
      error: error?.message ?? String(error)
    };
  }
}

async function inspectCookies(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });

    return cookies.map((cookie) => {
      const jwt = jwtMetadata(cookie.value);

      return {
        key: `${cookie.name}|${cookie.path}|${cookie.domain}`,
        name: cookie.name,
        session: cookie.session,
        expirationDate:
          Number.isFinite(cookie.expirationDate)
            ? cookie.expirationDate
            : null,
        authish:
          /(?:session|sess|sid|auth|token|jwt|login|identity|sso|connect)/i
            .test(cookie.name),
        jwtExp: jwt?.exp ?? null,
        jwtIat: jwt?.iat ?? null
      };
    });
  } catch {
    return [];
  }
}

function metadataKey(item) {
  return `${item.source}|${item.key}|${item.path ?? ""}`;
}

function detectRenewal(previous, current) {
  const evidence = [];

  const prevCookies = new Map(
    (previous.cookies ?? []).map((item) => [item.key, item])
  );

  for (const item of current.cookies ?? []) {
    const old = prevCookies.get(item.key);

    if (
      old?.expirationDate &&
      item.expirationDate &&
      item.expirationDate > old.expirationDate + 30
    ) {
      evidence.push({
        kind: item.authish ? "auth-cookie" : "cookie",
        key: item.name,
        oldExp: old.expirationDate,
        newExp: item.expirationDate
      });
    }

    if (
      old?.jwtExp &&
      item.jwtExp &&
      item.jwtExp > old.jwtExp + 30
    ) {
      evidence.push({
        kind: item.authish ? "auth-cookie-jwt" : "cookie-jwt",
        key: item.name,
        oldExp: old.jwtExp,
        newExp: item.jwtExp
      });
    }
  }

  const prevJwt = new Map(
    (previous.jwtMetadata ?? []).map((item) => [metadataKey(item), item])
  );

  for (const item of current.jwtMetadata ?? []) {
    const old = prevJwt.get(metadataKey(item));

    if (old?.exp && item.exp > old.exp + 30) {
      evidence.push({
        kind: "storage-jwt",
        key: `${item.source}:${item.key}`,
        oldExp: old.exp,
        newExp: item.exp
      });
    }
  }

  return evidence;
}

function findFixedExpiry(previous, current, nowSeconds) {
  const candidates = [];

  const prevJwt = new Map(
    (previous.jwtMetadata ?? []).map((item) => [metadataKey(item), item])
  );

  for (const item of current.jwtMetadata ?? []) {
    const old = prevJwt.get(metadataKey(item));

    if (
      old?.exp &&
      item.exp === old.exp &&
      item.exp > nowSeconds - 60
    ) {
      candidates.push({
        exp: item.exp,
        source: `${item.source}:${item.key}`,
        strong: /(?:session|sess|auth|token|jwt|login|identity|sso)/i
          .test(`${item.key} ${item.path ?? ""}`)
      });
    }
  }

  const prevCookies = new Map(
    (previous.cookies ?? []).map((item) => [item.key, item])
  );

  for (const item of current.cookies ?? []) {
    const old = prevCookies.get(item.key);

    if (
      item.jwtExp &&
      old?.jwtExp &&
      item.jwtExp === old.jwtExp &&
      item.jwtExp > nowSeconds - 60
    ) {
      candidates.push({
        exp: item.jwtExp,
        source: `cookie:${item.name}`,
        strong: item.authish
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.strong !== b.strong) {
      return a.strong ? -1 : 1;
    }
    return a.exp - b.exp;
  });

  return candidates[0] ?? null;
}

async function readHistory() {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  return result[HISTORY_KEY] ?? {};
}

async function recordExpiryHistory(origin, elapsedMs) {
  const history = await readHistory();
  const list = Array.isArray(history[origin]) ? history[origin] : [];

  list.push({
    at: Date.now(),
    elapsedMs
  });

  history[origin] = list.slice(-5);
  await chrome.storage.local.set({ [HISTORY_KEY]: history });

  return history[origin];
}

function repeatedFixedDuration(history) {
  if (!Array.isArray(history) || history.length < 2) {
    return false;
  }

  const recent = history.slice(-3);
  const durations = recent.map((item) => item.elapsedMs);

  for (let i = 0; i < durations.length; i += 1) {
    for (let j = i + 1; j < durations.length; j += 1) {
      const a = durations[i];
      const b = durations[j];
      const tolerance = Math.max(60_000, Math.min(a, b) * 0.10);

      if (Math.abs(a - b) <= tolerance) {
        return true;
      }
    }
  }

  return false;
}

async function recordAuthFailure(tabId, reason, observedAt = Date.now()) {
  const entry = await getEntry(tabId);
  if (!entry || entry.authFailureRecordedAt) {
    return;
  }

  const elapsedMs = Math.max(0, observedAt - entry.enabledAt);
  const history = await recordExpiryHistory(entry.origin, elapsedMs);
  const repeated = repeatedFixedDuration(history);

  await updateEntry(tabId, {
    lastAuthFailureAt: observedAt,
    lastAuthFailureReason: reason,
    authFailureRecordedAt: observedAt,
    repeatedFixedDuration: repeated
  });
}

function currentAssessment(entry) {
  if (!entry) {
    return {
      code: "disabled",
      label: "Disabled"
    };
  }

  const now = Date.now();

  if (entry.lastAuthFailureAt) {
    const fixedExpiryMs =
      entry.fixedExpiryAt
        ? entry.fixedExpiryAt * 1000
        : null;

    const nearFixedExpiry =
      fixedExpiryMs &&
      Math.abs(entry.lastAuthFailureAt - fixedExpiryMs) <= 5 * 60_000;

    if (nearFixedExpiry || entry.repeatedFixedDuration) {
      return {
        code: "likely-absolute",
        label: "Likely absolute/fixed TTL"
      };
    }

    return {
      code: "ineffective",
      label: "Keepalive ineffective / possible absolute TTL"
    };
  }

  if (
    entry.lastRenewalAt &&
    now - entry.lastRenewalAt <= 15 * 60_000
  ) {
    return {
      code: "sliding",
      label: "Sliding session detected"
    };
  }

  if (
    entry.fixedExpiryAt &&
    (entry.fixedExpiryStableCount ?? 0) >= 2
  ) {
    return {
      code: "fixed-expiry",
      label: "Fixed expiry detected"
    };
  }

  if ((entry.pulseCount ?? 0) >= 3) {
    return {
      code: "unknown",
      label: "No renewal evidence yet"
    };
  }

  return {
    code: "collecting",
    label: "Collecting session evidence"
  };
}

async function replayObservedXhrs(tabId, entry) {
  const options = mergedOptions(entry.options);
  if (!options.replaySafeXhr) {
    return {
      attempted: 0,
      succeeded: 0,
      errors: []
    };
  }

  const attached = await ensureDebugger(tabId);
  if (!attached) {
    return {
      attempted: 0,
      succeeded: 0,
      errors: ["Debugger unavailable"]
    };
  }

  const candidates = (entry.replayCandidates ?? [])
    .filter((item) =>
      item.method === "GET" &&
      item.type === "XHR" &&
      item.status >= 200 &&
      item.status < 300 &&
      isSafeReplayUrl(item.url, entry.origin)
    )
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, 2);

  let succeeded = 0;
  const errors = [];

  for (const candidate of candidates) {
    try {
      await chrome.debugger.sendCommand(
        { tabId },
        "Network.replayXHR",
        { requestId: candidate.requestId }
      );
      succeeded += 1;
    } catch (error) {
      errors.push(error?.message ?? String(error));
    }
  }

  return {
    attempted: candidates.length,
    succeeded,
    errors
  };
}

async function maybePeriodicReload(tabId, entry) {
  const options = mergedOptions(entry.options);
  if (!options.periodicReload) {
    return false;
  }

  const everyMinutes = Math.max(
    2,
    Number(options.reloadEveryMinutes) || 10
  );

  const lastReloadAt =
    entry.lastReloadAt ?? entry.enabledAt;

  if (
    Date.now() - lastReloadAt <
    everyMinutes * 60_000
  ) {
    return false;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    const windowInfo = await chrome.windows.get(tab.windowId);

    // Reload only when the user is not actively looking at this tab.
    if (tab.active && windowInfo.focused) {
      return false;
    }

    await updateEntry(tabId, {
      lastReloadAt: Date.now()
    });

    await chrome.tabs.reload(tabId, {
      bypassCache: false
    });

    return true;
  } catch {
    return false;
  }
}

async function pulseTab(tabId) {
  const entryBefore = await getEntry(tabId);
  if (!entryBefore) {
    return;
  }

  let tab;

  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    await disableTab(tabId);
    return;
  }

  const currentOrigin = httpOrigin(tab.url);
  if (!currentOrigin || currentOrigin !== entryBefore.origin) {
    await disableTab(tabId);
    return;
  }

  const options = mergedOptions(entryBefore.options);

  const cookiesBefore = entryBefore.lastCookieMetadata ?? [];
  const jwtBefore = entryBefore.lastJwtMetadata ?? [];

  const [debuggerReport, pageReport] = await Promise.all([
    debuggerActivity(tabId, options),
    pageActivity(tabId, options)
  ]);

  const cookiesAfter = await inspectCookies(tab.url);

  const currentMeta = {
    cookies: cookiesAfter,
    jwtMetadata: pageReport.jwtMetadata ?? []
  };

  const previousMeta = {
    cookies: cookiesBefore,
    jwtMetadata: jwtBefore
  };

  const renewalEvidence = detectRenewal(previousMeta, currentMeta);
  const nowSeconds = Math.floor(Date.now() / 1000);

  const fixedExpiry = findFixedExpiry(
    previousMeta,
    currentMeta,
    nowSeconds
  );

  const previousFixed =
    entryBefore.fixedExpiryAt &&
    fixedExpiry &&
    entryBefore.fixedExpiryAt === fixedExpiry.exp;

  const fixedExpiryStableCount =
    fixedExpiry
      ? previousFixed
        ? (entryBefore.fixedExpiryStableCount ?? 1) + 1
        : 1
      : 0;

  const replayReport =
    await replayObservedXhrs(tabId, await getEntry(tabId) ?? entryBefore);

  const patch = {
    lastPulseAt: Date.now(),
    pulseCount: (entryBefore.pulseCount ?? 0) + 1,

    debuggerAttached: debuggerReport.attached,
    idleEmulationOk: debuggerReport.idleOk,
    browserInputOk: debuggerReport.inputOk,
    debuggerDetails: debuggerReport.details,

    domActivityOk: pageReport.domActivityOk,
    pageFetchAttempted: pageReport.fetchAttempted,
    pageFetchOk: pageReport.fetchOk,
    pageFetchStatus: pageReport.fetchStatus,
    pageFetchRedirected: pageReport.fetchRedirected,
    pageFetchFinalUrl: pageReport.fetchFinalUrl,
    pageError: pageReport.error,

    documentVisibility: pageReport.documentVisibility,
    documentHasFocus: pageReport.documentHasFocus,

    replayAttempted: replayReport.attempted,
    replaySucceeded: replayReport.succeeded,
    replayErrors: replayReport.errors,

    lastCookieMetadata: cookiesAfter,
    lastJwtMetadata: pageReport.jwtMetadata ?? [],

    renewalEvidence,
    lastRenewalAt:
      renewalEvidence.length > 0
        ? Date.now()
        : entryBefore.lastRenewalAt ?? null,

    fixedExpiryAt: fixedExpiry?.exp ?? null,
    fixedExpirySource: fixedExpiry?.source ?? null,
    fixedExpiryStableCount
  };

  await updateEntry(tabId, patch);

  const fetchAuthFailure =
    pageReport.fetchAttempted &&
    [401, 403].includes(pageReport.fetchStatus);

  const redirectToLogin =
    pageReport.fetchRedirected &&
    pageReport.fetchFinalUrl &&
    isLoginLike(pageReport.fetchFinalUrl);

  const pageBecameLogin =
    !entryBefore.initialWasLoginLike &&
    pageReport.pageLoginLike;

  if (fetchAuthFailure) {
    await recordAuthFailure(
      tabId,
      `Current-page request returned HTTP ${pageReport.fetchStatus}`
    );
  } else if (redirectToLogin) {
    await recordAuthFailure(
      tabId,
      "Current-page request redirected to a login/sign-in URL"
    );
  } else if (pageBecameLogin) {
    await recordAuthFailure(
      tabId,
      "Tab navigated to a login/sign-in page"
    );
  }

  await maybePeriodicReload(
    tabId,
    await getEntry(tabId) ?? entryBefore
  );

  try {
    await setBadge(tabId, true);
  } catch {
    // Ignore tab/navigation races.
  }

  await scheduleNext(tabId);
}

async function enableTab(tab) {
  if (!tab?.id || !tab.url) {
    throw new Error("No usable active tab.");
  }

  const origin = httpOrigin(tab.url);
  if (!origin) {
    throw new Error(
      "Only ordinary HTTP/HTTPS pages are supported."
    );
  }

  const state = await readState();

  state[tab.id] = {
    origin,
    initialUrl: tab.url,
    initialWasLoginLike: isLoginLike(tab.url),
    enabledAt: Date.now(),
    lastPulseAt: null,
    pulseCount: 0,

    options: { ...DEFAULT_OPTIONS },

    replayCandidates: [],

    lastCookieMetadata: [],
    lastJwtMetadata: [],

    renewalEvidence: [],
    lastRenewalAt: null,

    fixedExpiryAt: null,
    fixedExpirySource: null,
    fixedExpiryStableCount: 0,

    lastAuthFailureAt: null,
    lastAuthFailureReason: null,
    authFailureRecordedAt: null,
    repeatedFixedDuration: false,

    lastReloadAt: null
  };

  await writeState(state);
  await setBadge(tab.id, true);
  await syncPowerState();

  await pulseTab(tab.id);
}

async function disableTab(tabId) {
  const state = await readState();

  if (state[tabId]) {
    delete state[tabId];
    await writeState(state);
  }

  await chrome.alarms.clear(alarmName(tabId));
  await detachDebugger(tabId);

  try {
    await setBadge(tabId, false);
  } catch {
    // Tab may already have been closed.
  }

  await syncPowerState();
}

async function setOptions(tabId, patch) {
  const entry = await getEntry(tabId);
  if (!entry) {
    throw new Error("Keepalive is not enabled for this tab.");
  }

  const options = {
    ...mergedOptions(entry.options),
    ...patch
  };

  options.reloadEveryMinutes = Math.max(
    2,
    Number(options.reloadEveryMinutes) || 10
  );

  await updateEntry(tabId, { options });
  await syncPowerState();

  if (
    !options.idleEmulation &&
    !options.browserInput &&
    !options.replaySafeXhr
  ) {
    await detachDebugger(tabId);
  }

  return options;
}

chrome.runtime.onMessage.addListener(
  (message, _sender, sendResponse) => {
    (async () => {
      if (message?.type === "get-status") {
        const entry = await getEntry(message.tabId);

        sendResponse({
          ok: true,
          enabled: Boolean(entry),
          info: entry,
          assessment: currentAssessment(entry)
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

        const entry = await getEntry(message.tabId);

        sendResponse({
          ok: true,
          enabled: Boolean(entry),
          info: entry,
          assessment: currentAssessment(entry)
        });
        return;
      }

      if (message?.type === "set-options") {
        await setOptions(
          message.tabId,
          message.options ?? {}
        );

        const entry = await getEntry(message.tabId);

        sendResponse({
          ok: true,
          enabled: Boolean(entry),
          info: entry,
          assessment: currentAssessment(entry)
        });
        return;
      }

      if (message?.type === "pulse-now") {
        await pulseTab(message.tabId);
        const entry = await getEntry(message.tabId);

        sendResponse({
          ok: true,
          enabled: Boolean(entry),
          info: entry,
          assessment: currentAssessment(entry)
        });
        return;
      }

      sendResponse({
        ok: false,
        error: "Unknown request."
      });
    })().catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message ?? String(error)
      });
    });

    return true;
  }
);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const tabId = parseTabId(alarm.name);
  if (tabId === null) {
    return;
  }

  await pulseTab(tabId);
});

chrome.tabs.onUpdated.addListener(
  async (tabId, changeInfo, tab) => {
    const entry = await getEntry(tabId);
    if (!entry) {
      return;
    }

    const url = changeInfo.url ?? tab.url;
    const currentOrigin = httpOrigin(url);

    if (currentOrigin && currentOrigin !== entry.origin) {
      await disableTab(tabId);
      return;
    }

    if (
      !entry.initialWasLoginLike &&
      url &&
      isLoginLike(url)
    ) {
      await recordAuthFailure(
        tabId,
        "Tab navigated to a login/sign-in URL"
      );
    }

    if (
      changeInfo.status === "loading" ||
      changeInfo.status === "complete" ||
      Boolean(changeInfo.url)
    ) {
      try {
        await setBadge(tabId, true);
      } catch {
        // Ignore transient navigation races.
      }
    }
  }
);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await disableTab(tabId);
});

chrome.debugger.onEvent.addListener(
  async (source, method, params) => {
    const tabId = source.tabId;
    if (!Number.isInteger(tabId)) {
      return;
    }

    const entry = await getEntry(tabId);
    if (!entry) {
      return;
    }

    if (method === "Network.requestWillBeSent") {
      const request = params?.request;
      const type = params?.type;

      if (
        request?.method === "GET" &&
        type === "XHR" &&
        isSafeReplayUrl(request.url, entry.origin)
      ) {
        const candidates = [
          ...(entry.replayCandidates ?? [])
        ].filter(
          (item) => item.requestId !== params.requestId
        );

        candidates.unshift({
          requestId: params.requestId,
          url: request.url,
          method: request.method,
          type,
          status: null,
          mimeType: null,
          lastSeenAt: Date.now()
        });

        await updateEntry(tabId, {
          replayCandidates: candidates.slice(0, 10)
        });
      }

      return;
    }

    if (method === "Network.responseReceived") {
      const response = params?.response;
      const requestId = params?.requestId;

      const candidates = [
        ...(entry.replayCandidates ?? [])
      ];

      const index = candidates.findIndex(
        (item) => item.requestId === requestId
      );

      if (index >= 0) {
        candidates[index] = {
          ...candidates[index],
          status: Number(response?.status) || null,
          mimeType: response?.mimeType ?? null,
          lastSeenAt: Date.now()
        };

        await updateEntry(tabId, {
          replayCandidates: candidates
        });
      }
    }
  }
);

chrome.debugger.onDetach.addListener(async (source) => {
  if (!Number.isInteger(source.tabId)) {
    return;
  }

  const entry = await getEntry(source.tabId);
  if (!entry) {
    return;
  }

  await updateEntry(source.tabId, {
    debuggerAttached: false,
    debuggerDetails: [
      "Debugger detached; it will retry on the next pulse."
    ]
  });
});
