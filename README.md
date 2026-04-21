# Detour

A Chromium extension for HTTP redirect and script injection rules during local development and testing.

Redirect requests. Inject scripts. Bypass CSP.

## What it does

- **Redirect rules** — Reroute network requests using wildcard, contains, equals, or regex matching. Redirects apply at both the network level (via `declarativeNetRequest`) and in-page (by patching `fetch`/`XMLHttpRequest`).
- **Script injection rules** — Inject external scripts into any page, bypassing Content Security Policy. The service worker fetches the script text and injects it via `chrome.scripting.executeScript` in the MAIN world — no `<script src>` tag needed.
- **Per-tab badge** — Shows how many rules fired on the active tab.
- **Import / Export** — Share rule sets as JSON files.

## Architecture

```
popup.html / popup.js      — Extension popup UI (rule list + editor)
service-worker.js           — Background: storage, DNR sync, script injection, messaging
loader.js                   — Content script (ISOLATED world, document_start): passes redirect rules to page context
page-script.js              — Content script (MAIN world, document_start): patches fetch/XHR before app code runs
```

**Redirect flow:**
1. `loader.js` reads rules from `chrome.storage` and sets `window.__REQUEST_RULES_REDIRECTS__` via an inline script tag.
2. `page-script.js` patches `fetch` and `XHR.open` to read those rules at call-time and rewrite URLs.
3. The service worker also registers matching rules with `declarativeNetRequest` for network-level redirects.

**Script injection flow:**
1. The service worker listens to `webNavigation.onCommitted`.
2. For matching pages, it fetches external script text (cached for 5 minutes).
3. Injects via `chrome.scripting.executeScript({ world: "MAIN" })`, which bypasses all CSP.

## Install

**From the Chrome Web Store:** [chromewebstore.google.com/detail/detour](https://chromewebstore.google.com/detail/detour/cinkplogkjggmgdkaflhlemcdhchninp)

### From source (unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.

## Build for Chrome Web Store

Requires [sharp](https://sharp.pixelplumbing.com/) (`npm install sharp`).

```bash
node scripts/build.js
```

This regenerates PNG icons from `icon.svg` and packages everything into `detour-<version>.zip`.

## Rule format

Rules are stored in `chrome.storage.local` as an array:

```json
{
  "id": "my-rule",
  "name": "Mock auth API",
  "type": "redirect",
  "enabled": true,
  "source": { "operator": "wildcard", "value": "https://app.example.com/api/auth/*" },
  "destination": "http://localhost:4000/api/auth/$1",
  "scripts": []
}
```

| Field         | Description                                                  |
|---------------|--------------------------------------------------------------|
| `type`        | `"redirect"` or `"script"`                                   |
| `source`      | Match condition: `operator` (`wildcard`, `contains`, `equals`, `regex`) + `value` |
| `destination` | Redirect target URL (supports `$1`, `$2` capture groups)     |
| `scripts`     | Array of `{ src, attrs? }` for script-type rules             |

## Files not shipped

The build zip includes only runtime files. These stay out of the package:

- `icon.svg`, `scripts/`, `assets/`, `README.md`, `.gitignore`
