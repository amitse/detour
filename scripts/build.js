/* build.js — Build Detour for the Chrome Web Store.
 *
 *   1. Regenerates PNG icons from icon.svg (via build-icons.js).
 *   2. Packages all runtime files into detour-<version>.zip with manifest.json
 *      at the zip root, ready to upload to the Web Store dashboard.
 *
 * Usage: node scripts/build.js
 *
 * Pure Node — no extra dependencies beyond `sharp` (already used by build-icons).
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

// Files to ship in the zip. Anything not listed here (icon.svg, build.js,
// build-icons.js, README, etc.) stays out of the package.
const RUNTIME_FILES = [
  "manifest.json",
  "popup.html",
  "popup.js",
  "loader.js",
  "page-script.js",
  "service-worker.js",
  "icon.svg",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
];

// ── 1. Regenerate icons ────────────────────────────────────────────────────

console.log("→ regenerating icons");
execFileSync(process.execPath, [path.join(__dirname, "build-icons.js")], {
  stdio: "inherit",
});

// ── 2. Validate manifest ───────────────────────────────────────────────────

const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")
);
const version = manifest.version;
if (!/^\d+(\.\d+){0,3}$/.test(version)) {
  throw new Error(`invalid manifest version: ${version}`);
}
if (manifest.description && manifest.description.length > 132) {
  throw new Error(
    `description too long: ${manifest.description.length} > 132 chars`
  );
}
console.log(`→ manifest ok (version ${version})`);

// ── 3. Build the zip ───────────────────────────────────────────────────────
//
// Minimal ZIP writer: one local file header + deflated data per entry,
// followed by a central directory and end-of-central-directory record.
// See APPNOTE.TXT (PKWARE) §4.3 for the format.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return (
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((d.getSeconds() / 2) & 0x1f)
  );
}
function dosDate(d) {
  return (
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0xf) << 5) |
    (d.getDate() & 0x1f)
  );
}

function buildZip(entries) {
  const now = new Date();
  const time = dosTime(now);
  const date = dosDate(now);
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(8, 8);            // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 8);          // flags
    central.writeUInt16LE(8, 10);         // method
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra length
    central.writeUInt16LE(0, 32);         // comment length
    central.writeUInt16LE(0, 34);         // disk number
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0, 38);         // external attrs
    central.writeUInt32LE(offset, 42);    // local header offset
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralChunks);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // EOCD signature
  end.writeUInt16LE(0, 4);                // disk number
  end.writeUInt16LE(0, 6);                // disk with central dir
  end.writeUInt16LE(entries.length, 8);   // entries on this disk
  end.writeUInt16LE(entries.length, 10);  // total entries
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...localChunks, centralBuf, end]);
}

const entries = RUNTIME_FILES.map((rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`missing runtime file: ${rel}`);
  return { name: rel.replace(/\\/g, "/"), data: fs.readFileSync(abs) };
});

const zipPath = path.join(ROOT, `detour-${version}.zip`);
fs.writeFileSync(zipPath, buildZip(entries));

const sizeKb = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`→ wrote ${path.basename(zipPath)} (${sizeKb} KB, ${entries.length} files)`);
