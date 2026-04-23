/* capture-screenshots.js — Generate Chrome Web Store screenshots.
 *
 * Loads the Detour extension into a headed Chromium (extensions aren't
 * reliable in headless even with --headless=new), seeds a few demo rules
 * into chrome.storage.local via the service worker, then renders panel.html
 * at 1280×800 and popup.html at its native size.
 *
 * Also generates the Web Store promo tile (440×280) from a small HTML
 * template that reuses the brand palette and typography tokens.
 *
 * Playwright isn't a declared dep of this repo — we borrow the install from
 * the npx cache that ships with Claude Code's tooling. If that path isn't
 * present, run `npm i playwright` locally and point PLAYWRIGHT_MODULE at
 * the install dir.
 *
 * Usage:
 *   node scripts/capture-screenshots.js             # popup + panel (light)
 *   node scripts/capture-screenshots.js --dark      # dark color scheme
 *   node scripts/capture-screenshots.js --headed    # show the window
 *   node scripts/capture-screenshots.js --promo     # 440×280 promo tile
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");

// ── Locate Playwright ─────────────────────────────────────────────────────
// The repo doesn't have playwright in its node_modules, but the npx cache
// on this machine does. Fall back to require() which works if it ever gets
// added as a real dep later.
function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) {
    return require(process.env.PLAYWRIGHT_MODULE);
  }
  try {
    return require("playwright");
  } catch (e) {
    const cacheRoot = "D:/packages/npm/_npx";
    if (fs.existsSync(cacheRoot)) {
      for (const dir of fs.readdirSync(cacheRoot)) {
        const candidate = path.join(cacheRoot, dir, "node_modules", "playwright");
        if (fs.existsSync(path.join(candidate, "package.json"))) {
          return require(candidate);
        }
      }
    }
    throw new Error("Playwright not found. Run `npm i playwright` or set PLAYWRIGHT_MODULE.");
  }
}

const { chromium } = loadPlaywright();

// ── Args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DARK = argv.includes("--dark");
const HEADED = argv.includes("--headed");
const PROMO = argv.includes("--promo");
const PROMO_LARGE = argv.includes("--promo-large");
// --empty: zero-rules empty state (teaches UI + shows brand)
// --edit:  edit form mid-authoring (shows the rule editor)
// default: populated rules list
const VARIANT = argv.includes("--empty") ? "empty"
              : argv.includes("--edit")  ? "edit"
              : "rules";

// ── Demo rules for the screenshot ─────────────────────────────────────────
// Picked to read realistically (each has a job, nothing is placeholder-y)
// and to show a mix of enabled/disabled, redirect/script, with execution
// counts. Names are short so they don't ellipsize.
const DEMO_RULES = [
  {
    id: "demo-auth",
    name: "mock-auth",
    type: "redirect",
    enabled: true,
    source: { operator: "wildcard", value: "https://app.example.com/api/auth/*", method: "ALL" },
    destination: "http://localhost:4000/api/auth/$1",
    scripts: [],
  },
  {
    id: "demo-flags",
    name: "force-flags",
    type: "redirect",
    enabled: true,
    source: { operator: "wildcard", value: "https://app.example.com/flags.json", method: "GET" },
    destination: "http://localhost:4000/flags-dev.json",
    scripts: [],
  },
  {
    id: "demo-analytics",
    name: "block-telemetry",
    type: "redirect",
    enabled: false,
    source: { operator: "wildcard", value: "*analytics.example.com*", method: "ALL" },
    destination: "data:text/plain,",
    scripts: [],
  },
  {
    id: "demo-overlay",
    name: "dev-overlay",
    type: "script",
    enabled: true,
    source: { operator: "wildcard", value: "*app.example.com*", method: "ALL" },
    destination: "",
    scripts: [{ src: "https://cdn.example.com/assets/dev-overlay.js" }],
  },
];

const DEMO_URL = "app.example.com/dashboard";

// ── Capture ───────────────────────────────────────────────────────────────
async function capture() {
  if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "detour-pw-"));

  console.log("→ launching chromium with extension…");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !HEADED,
    channel: "chromium",
    colorScheme: DARK ? "dark" : "light",
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
    ],
  });

  // Wait for the MV3 service worker to register.
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 10_000 });
  }
  const extensionId = new URL(sw.url()).host;
  console.log(`→ extension id: ${extensionId}`);

  // The service worker's onInstalled handler writes DEFAULT_RULES to
  // storage asynchronously at registration. Wait until that lands before
  // overwriting with our demo seed — otherwise a race can drop the seed.
  await sw.evaluate(async () => {
    for (let i = 0; i < 20; i++) {
      const { rules } = await chrome.storage.local.get("rules");
      if (rules && rules.length) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  // Variant-specific storage state.
  if (VARIANT === "empty") {
    await sw.evaluate(async () => {
      await chrome.storage.local.set({
        rules: [],
        settings: { enabled: true, presets: { cors: false, csp: false, xfo: false } },
      });
    });
  } else {
    await sw.evaluate(async (rules) => {
      await chrome.storage.local.set({
        rules,
        settings: { enabled: true, presets: { cors: false, csp: true, xfo: false } },
      });
    }, DEMO_RULES);
  }

  // Render the panel at 1280×800. panel.html reuses popup.css with
  // body.surface-panel, which caps the column at 560px and centers it.
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/panel.html`);

  // Helper: overwrite the URL hero (popup.js resolves it to panel.html's
  // own chrome-extension URL in a standalone tab — ugly for a screenshot).
  async function setHero(url) {
    await page.evaluate((u) => {
      const el = document.getElementById("page-url");
      if (el) {
        el.textContent = u;
        el.removeAttribute("data-empty");
        el.title = "https://" + u;
      }
    }, url);
  }

  // Helper: stamp execution counts on named rule rows so rules read as
  // "alive", not sleeping. Takes { ruleName: count } pairs.
  async function stampCounts(fired) {
    await page.evaluate((counts) => {
      for (const [name, count] of Object.entries(counts)) {
        document.querySelectorAll(".rule-row").forEach((row) => {
          const nameEl = row.querySelector(".rule-name");
          if (nameEl && nameEl.textContent === name) {
            const badge = row.querySelector(".exec-count");
            if (badge) {
              badge.textContent = count;
              badge.classList.add("visible");
            }
          }
        });
      }
    }, fired);
  }

  const suffix = DARK ? "-dark" : "";
  let outName;

  if (VARIANT === "empty") {
    // Empty state: wait for the teaching empty blocks to unhide.
    await page.waitForSelector("#empty-redirect:not(.hidden)", { timeout: 8000 });
    await setHero(DEMO_URL);
    await page.waitForTimeout(300);
    outName = `screenshot-empty-1280x800${suffix}.png`;
  } else if (VARIANT === "edit") {
    await page.waitForSelector(".rule-row", { timeout: 8000 });
    // Open the edit view by clicking mock-auth's row button.
    await page.evaluate(() => {
      document.querySelectorAll(".rule-row").forEach((row) => {
        const nameEl = row.querySelector(".rule-name");
        if (nameEl && nameEl.textContent === "mock-auth") {
          const btn = row.querySelector(".rule-open");
          if (btn) btn.click();
        }
      });
    });
    await page.waitForSelector("#edit-view:not(.hidden)", { timeout: 4000 });
    await page.waitForTimeout(300);
    outName = `screenshot-edit-1280x800${suffix}.png`;
  } else {
    await page.waitForSelector(".rule-row", { timeout: 8000 });
    await setHero(DEMO_URL);
    await stampCounts({ "mock-auth": 12, "force-flags": 3, "dev-overlay": 1 });
    await page.waitForTimeout(300);
    outName = `screenshot-1280x800${suffix}.png`;
  }

  const panelPath = path.join(ASSETS, outName);
  await page.screenshot({ path: panelPath, fullPage: false });
  console.log(`→ wrote ${path.relative(ROOT, panelPath)}`);

  // Bonus: raw popup at native size for the README — only for the default
  // populated view. The edit + empty variants already captured their 1280.
  if (VARIANT === "rules") {
    await page.setViewportSize({ width: 420, height: 760 });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForSelector(".rule-row", { timeout: 8000 });
    await setHero(DEMO_URL);
    await stampCounts({ "mock-auth": 12, "force-flags": 3, "dev-overlay": 1 });
    await page.waitForTimeout(300);

    const popupPath = path.join(ASSETS, `popup${suffix}.png`);
    await page.screenshot({ path: popupPath, fullPage: true });
    console.log(`→ wrote ${path.relative(ROOT, popupPath)}`);
  }

  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

// ── Promo tile (440×280) ──────────────────────────────────────────────────
// The Web Store's small promo is a graphic composition, not a UI capture.
// Reuses the brand palette + typography from popup.css so the promo and
// the product read as one system. A faint `*` watermark nods to wildcard
// syntax without resorting to illustration.
function promoHTML({ dark }) {
  const bg = dark ? "oklch(0.18 0.01 240)" : "oklch(0.982 0.005 225)";
  const fg = dark ? "oklch(0.91 0.012 230)" : "oklch(0.24 0.02 250)";
  const fg2 = dark ? "oklch(0.76 0.014 230)" : "oklch(0.5 0.016 250)";
  const accent = dark ? "#6cb6d6" : "#2a7598";
  const watermarkAlpha = dark ? 0.10 : 0.07;
  const iconSvg = fs.readFileSync(path.join(ROOT, "icon.svg"), "utf8");
  const iconDataUri = "data:image/svg+xml;base64," + Buffer.from(iconSvg).toString("base64");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 440px; height: 280px; overflow: hidden; }
  body {
    background: ${bg};
    color: ${fg};
    font-family: "Instrument Sans", "Aptos", "Segoe UI Variable Text", "Segoe UI", Helvetica, Arial, sans-serif;
    font-kerning: normal;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    position: relative;
  }
  .canvas {
    position: relative;
    width: 100%;
    height: 100%;
    padding: 40px 40px 36px;
    display: grid;
    align-content: start;
    gap: 16px;
    z-index: 1;
  }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: ${fg2};
  }
  .mark {
    width: 22px; height: 22px;
    border-radius: 5px;
    display: block;
  }
  h1 {
    font-family: "Newsreader", "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    font-size: 40px;
    line-height: 1.0;
    font-weight: 500;
    letter-spacing: -0.03em;
    color: ${fg};
    margin-top: 6px;
  }
  p {
    font-size: 13px;
    line-height: 1.5;
    color: ${fg2};
    max-width: 34ch;
    margin-top: 4px;
  }
  .tag {
    color: ${accent};
    font-weight: 600;
    font-family: "JetBrains Mono", "SF Mono", Consolas, monospace;
  }
  .watermark {
    position: absolute;
    top: -60px;
    right: -40px;
    font-family: "JetBrains Mono", "SF Mono", Consolas, monospace;
    font-size: 340px;
    line-height: 1;
    color: ${accent};
    opacity: ${watermarkAlpha};
    user-select: none;
    pointer-events: none;
    z-index: 0;
  }
</style>
</head>
<body>
  <div class="watermark">*</div>
  <div class="canvas">
    <div class="eyebrow">
      <img class="mark" src="${iconDataUri}" alt="">
      <span>Detour</span>
    </div>
    <h1>Redirect requests.<br>Inject scripts.</h1>
    <p>A Chromium extension for local testing.</p>
  </div>
</body>
</html>`;
}

async function capturePromo() {
  if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });

  console.log("→ launching chromium for promo render…");
  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage({
    viewport: { width: 440, height: 280 },
    deviceScaleFactor: 1, // Web Store expects exact pixel dimensions; no 2x
  });

  const html = promoHTML({ dark: DARK });
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(200); // let fonts settle

  const out = path.join(ASSETS, `promo-440x280${DARK ? "-dark" : ""}.png`);
  await page.screenshot({ path: out, fullPage: false, omitBackground: false });
  console.log(`→ wrote ${path.relative(ROOT, out)}`);

  await browser.close();
}

// ── Large promo tile (1400×560) ───────────────────────────────────────────
// The Web Store marquee — big enough to afford a product shot beside the
// copy. Left column: editorial headline. Right column: the real popup PNG
// (rendered upstream via `node scripts/capture-screenshots.js` then reused
// here). Requires assets/popup.png or popup-dark.png to already exist.
function promoLargeHTML({ dark }) {
  const bg = dark ? "oklch(0.18 0.01 240)" : "oklch(0.982 0.005 225)";
  const bg2 = dark ? "oklch(0.22 0.011 240)" : "oklch(0.957 0.007 225)";
  const fg = dark ? "oklch(0.91 0.012 230)" : "oklch(0.24 0.02 250)";
  const fg2 = dark ? "oklch(0.76 0.014 230)" : "oklch(0.5 0.016 250)";
  const accent = dark ? "#6cb6d6" : "#2a7598";

  const popupName = dark ? "popup-dark.png" : "popup.png";
  const popupPath = path.join(ASSETS, popupName);
  if (!fs.existsSync(popupPath)) {
    throw new Error(`${popupName} not found — run the main capture first (without --promo) to produce it.`);
  }
  const popupDataUri = "data:image/png;base64," + fs.readFileSync(popupPath).toString("base64");

  const iconSvg = fs.readFileSync(path.join(ROOT, "icon.svg"), "utf8");
  const iconDataUri = "data:image/svg+xml;base64," + Buffer.from(iconSvg).toString("base64");

  // Shadow tuned so the popup reads as a product shot, not a floating UI
  // element — soft and brand-tinted instead of hard black.
  const shadow = dark
    ? "0 30px 70px rgba(0,0,0,0.55), 0 10px 24px rgba(0,0,0,0.4)"
    : "0 30px 70px rgba(30,50,80,0.14), 0 10px 24px rgba(30,50,80,0.10)";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1400px; height: 560px; overflow: hidden; }
  body {
    background: ${bg};
    color: ${fg};
    font-family: "Instrument Sans", "Aptos", "Segoe UI Variable Text", "Segoe UI", Helvetica, Arial, sans-serif;
    font-kerning: normal;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    position: relative;
    display: grid;
    grid-template-columns: 1fr 520px;
    gap: 40px;
    padding: 80px 80px 80px 96px;
  }
  .copy {
    display: grid;
    align-content: center;
    gap: 24px;
    max-width: 620px;
  }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 14px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: ${fg2};
  }
  .mark {
    width: 28px; height: 28px;
    border-radius: 6px;
    display: block;
  }
  h1 {
    font-family: "Newsreader", "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    font-size: 84px;
    line-height: 0.98;
    font-weight: 500;
    letter-spacing: -0.035em;
    color: ${fg};
  }
  p.sub {
    font-size: 20px;
    line-height: 1.4;
    color: ${fg2};
    max-width: 42ch;
    margin-top: 4px;
  }
  .product {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .product img {
    display: block;
    height: 520px;
    width: auto;
    border-radius: 14px;
    box-shadow: ${shadow};
    background: ${bg2};
  }
</style>
</head>
<body>
  <div class="copy">
    <div class="eyebrow">
      <img class="mark" src="${iconDataUri}" alt="">
      <span>Detour</span>
    </div>
    <h1>Redirect requests.<br>Inject scripts.</h1>
    <p class="sub">A Chromium extension for local testing. Rewrite network requests and load external code into any page — without touching production.</p>
  </div>
  <div class="product">
    <img src="${popupDataUri}" alt="Detour popup">
  </div>
</body>
</html>`;
}

async function capturePromoLarge() {
  if (!fs.existsSync(ASSETS)) fs.mkdirSync(ASSETS, { recursive: true });
  console.log("→ launching chromium for large promo render…");
  const browser = await chromium.launch({ headless: !HEADED });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 560 },
    deviceScaleFactor: 1,
  });
  const html = promoLargeHTML({ dark: DARK });
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(250);
  const out = path.join(ASSETS, `promo-1400x560${DARK ? "-dark" : ""}.png`);
  await page.screenshot({ path: out, fullPage: false, omitBackground: false });
  console.log(`→ wrote ${path.relative(ROOT, out)}`);
  await browser.close();
}

const route = PROMO_LARGE ? capturePromoLarge() : PROMO ? capturePromo() : capture();
route.catch((err) => {
  console.error(err);
  process.exit(1);
});
