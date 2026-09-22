/**
 * Point DocLink at the mock IREPS server or back at the real portal.
 *
 *   node test/mock/switch-target.mjs mock     -> http://localhost:8765
 *   node test/mock/switch-target.mjs real     -> https://www.ireps.gov.in
 *   node test/mock/switch-target.mjs status
 *
 * It edits exactly two things and nothing else:
 *   - manifest.json        host_permissions
 *   - services/ireps-api.js IREPS_CONFIG.baseUrl
 *
 * Reload the extension on chrome://extensions after switching.
 * Always switch back to "real" before sharing or packaging the extension.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(root, "manifest.json");
const apiPath = join(root, "services", "ireps-api.js");

const REAL = "https://www.ireps.gov.in";
const MOCK = `http://localhost:${process.env.PORT || 8765}`;

const mode = process.argv[2];
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
let api = readFileSync(apiPath, "utf8");
const current = (api.match(/baseUrl:\s*"([^"]+)"/) || [])[1];

if (mode === "status" || !mode) {
  console.log(`baseUrl: ${current}`);
  console.log(`host_permissions: ${JSON.stringify(manifest.host_permissions)}`);
  if (!mode) console.log("\nusage: node test/mock/switch-target.mjs mock|real|status");
  process.exit(0);
}

const target = mode === "mock" ? MOCK : mode === "real" ? REAL : null;
if (!target) {
  console.error(`unknown mode "${mode}" (use mock | real | status)`);
  process.exit(1);
}

api = api.replace(/baseUrl:\s*"[^"]+"/, `baseUrl: "${target}"`);
manifest.host_permissions = [`${target}/*`];

writeFileSync(apiPath, api);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`DocLink now targets ${target}`);
console.log("Next: chrome://extensions -> reload DocLink");
if (mode === "mock") console.log(`Then open ${target}/ in a tab and click Login.`);
