# Local Tab Keepalive

Version 1.0.1

## Changes in 1.0.1

- Restores the green `ON` badge after a page reload.
- Keeps the badge across navigation within the same origin.
- Immediately disables keepalive if the tab navigates to a different origin.

## Install / update

1. Extract this folder somewhere permanent.
2. Open `chrome://extensions/`.
3. If replacing v1.0.0, remove the old unpacked extension or point it at this new folder.
4. Enable Developer mode.
5. Click **Load unpacked** and select this folder.
6. If using Incognito, open **Details** and enable **Allow in Incognito**.

When enabled, the extension generates harmless local page activity every ~35–55 seconds:
synthetic pointer/mouse movement plus a small scroll that is immediately restored.

It performs no clicks, no typing, and no external network requests.
