# Local Tab Keepalive v3.0.0

A local-only Chrome extension that combines multiple generic session keepalive
mechanisms and tries to diagnose what kind of session expiration the site uses.

## Default keepalive mechanisms

Enabled by default:

1. Chrome idle/focus emulation
   - Uses the Chrome DevTools Protocol to report the user as active/unlocked.
   - Enables focus emulation for the tab.

2. Browser-level input
   - Mouse movement.
   - Shift key down/up.
   - Does not click or type text.

3. DOM activity
   - Pointer/mouse/focus events.
   - Tiny scroll followed by exact scroll-position restoration.

4. Authenticated current-page GET
   - A real same-origin GET request to the URL already loaded.
   - Uses the page's normal cookies.
   - Does not call third-party servers.

## Optional aggressive mechanisms

Disabled by default:

### Replay observed safe GET XHRs

While the DevTools connection is active, the extension remembers recent
same-origin XHR requests that used HTTP GET and excludes URLs containing common
destructive action words such as logout, delete, revoke, payment, etc.

When enabled, it can replay up to two successful observed GET XHRs using
Chrome's Network.replayXHR facility.

This can help applications where only authenticated API traffic refreshes the
server-side session.

It is still considered aggressive because HTTP GET is *supposed* to be
side-effect-free, but poorly designed sites can violate that convention.

### Periodic background reload

Reloads the page at the selected interval, but only when:

- the tab is not the active tab, or
- Chrome is not the focused macOS application.

This is intentionally disabled by default because a reload can discard
unsaved page state.

### Prevent computer sleep

Uses Chrome's power API to keep the Mac/system awake while enabled.
The display can still turn off.

## Session diagnostics

The popup reports one of these assessments:

- **Sliding session detected**
  - The extension observed a cookie expiry or JWT expiry move forward.

- **Fixed expiry detected**
  - A JWT-like token expiry remained unchanged over multiple keepalive pulses.

- **Keepalive ineffective / possible absolute TTL**
  - The page/request still reached an authentication failure or login page while
    keepalive was running.

- **Likely absolute/fixed TTL**
  - Authentication failure occurred close to a repeatedly observed fixed token
    expiry, or repeated sessions expired after approximately the same duration.

- **No renewal evidence yet**
  - Keepalive is running successfully, but there is no generic browser-visible
    proof that the server extended the session.

The extension never stores JWT/token values in its diagnostics. It only keeps
metadata such as token expiry/issued-at timestamps.

## Chrome debugger warning

Chrome will show a banner similar to:

    "Local Tab Keepalive started debugging this browser"

This is expected because browser-level input, idle/focus emulation, network
observation, and XHR replay use Chrome's Debugger/DevTools API.

Do not click Cancel if those mechanisms should remain active.

## Installation

1. Extract this archive somewhere permanent.
2. Open `chrome://extensions/`.
3. Remove the previous unpacked Local Tab Keepalive version.
4. Enable Developer mode.
5. Click **Load unpacked**.
6. Select the `tab-keepalive-v3` directory.
7. For Incognito use, open the extension's Details page and enable
   **Allow in Incognito**.
8. Open the page you want kept alive and enable the extension.

## Fundamental limit

A server can intentionally enforce an absolute maximum session/token lifetime
that cannot be renewed by additional browser activity or requests.

No site-independent extension can legitimately turn such a fixed server-side
deadline into a sliding one. In that case v3's goal is to identify the evidence
rather than falsely report that the keepalive is working.
