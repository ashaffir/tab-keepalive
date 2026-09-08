# Local Tab Keepalive

A minimal Manifest V3 Chrome extension intended to be loaded unpacked from your own machine.

## What it does

When enabled for a tab, approximately every 35–55 seconds it:

- dispatches synthetic `pointermove` and `mousemove` events at a random point in the viewport;
- performs a small real page scroll and restores the exact previous scroll position;
- makes no clicks;
- types nothing;
- makes no external network requests.

The extension automatically disables itself if the tab navigates to a different origin.

## Important limitation

Chrome extensions cannot physically move the operating-system mouse cursor.

The generated mouse/pointer events are synthetic (`event.isTrusted === false`).
Sites that deliberately require trusted physical-user events can ignore them.

The scroll itself is a real DOM/window scroll and therefore also causes normal browser scroll handling.

## Install locally

1. Extract/open this folder somewhere permanent.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this folder (`tab-keepalive`).
6. Pin **Local Tab Keepalive** from the Extensions menu if desired.
7. Open the tab you want to keep alive.
8. Click the extension and enable **Keep this tab active**.

The toolbar badge shows `ON` while enabled.

## Permissions

- `alarms`: schedules activity while the tab is in the background.
- `scripting`: runs the keepalive activity in the selected tab.
- `storage`: remembers which tabs are enabled during the current browser session.
- `tabs`: identifies and validates the selected tab.
- `http://*/*`, `https://*/*`: allows the activity script to run on ordinary web pages.

There is no analytics code, remote script, update server, or external dependency.
