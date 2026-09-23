/**
 * Convenience for engineers with a terminal handy: sets config.json's
 * "target" field. Everyone else edits config.json directly - open it in any
 * text editor, change "target" to "mock" or "real", save, then reload
 * DocLink in chrome://extensions. That is the ONLY thing that needs to
 * change; manifest.json declares both origins permanently.
 *
 *   node test/mock/switch-target.mjs mock     -> http://localhost:8765
 *   node test/mock/switch-target.mjs real     -> https://www.ireps.gov.in
 *   node test/mock/switch-target.mjs status
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const configPath = join(root, "config.json");

const mode = process.argv[2];
const config = JSON.parse(readFileSync(configPath, "utf8"));

function effectiveBaseUrl(cfg) {
  if (cfg.baseUrl) return cfg.baseUrl;
  if (cfg.target === "real") return cfg.realBaseUrl || "https://www.ireps.gov.in";
  return cfg.mockBaseUrl || "http://localhost:8765";
}

if (mode === "status" || !mode) {
  console.log(`target: ${config.target}`);
  console.log(`effective baseUrl: ${effectiveBaseUrl(config)}`);
  if (!mode) console.log("\nusage: node test/mock/switch-target.mjs mock|real|status");
  process.exit(0);
}

if (mode !== "mock" && mode !== "real") {
  console.error(`unknown mode "${mode}" (use mock | real | status)`);
  process.exit(1);
}

config.target = mode;
delete config.baseUrl; // an explicit override would otherwise keep pointing at the old target
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(`config.json target -> ${mode} (${effectiveBaseUrl(config)})`);
console.log("Next: chrome://extensions -> reload DocLink");
if (mode === "mock") console.log(`Then open ${effectiveBaseUrl(config)}/ in a tab and click Login.`);
