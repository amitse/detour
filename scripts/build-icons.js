/* Build PNG icons from icon.svg using sharp. Run with: node scripts/build-icons.js */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const svg = fs.readFileSync(path.join(ROOT, "icon.svg"));
const sizes = [16, 32, 48, 128];

(async () => {
  fs.mkdirSync(path.join(ROOT, "icons"), { recursive: true });
  for (const size of sizes) {
    const out = path.join(ROOT, "icons", `icon-${size}.png`);
    await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out);
    console.log("wrote", out);
  }
})();
