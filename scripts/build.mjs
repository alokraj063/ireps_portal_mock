/**
 * Builds a shareable copy of DocLink in dist/doclink/ and zips it.
 *
 * Each JS entry point (with its module graph under services/ and utils/) is
 * bundled into one file, minified, then run through javascript-obfuscator to
 * rename identifiers, encode strings and flatten control flow. HTML, CSS,
 * assets, manifest.json and config.json are copied unchanged. The source
 * tree is never modified.
 *
 * The obfuscator settings avoid selfDefending / debugProtection, which rely on
 * Function() and would be blocked by the Manifest V3 content-security-policy.
 *
 * Usage: npm install && npm run build
 */
import { build } from "esbuild";
import obfuscator from "javascript-obfuscator";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const OUT = join(DIST, "doclink");

/** Entry points loaded by manifest.json or by <script type="module"> in HTML. */
const ENTRY_POINTS = [
  "background/service-worker.js",
  "background/offscreen.js",
  "popup/popup.js",
  "pages/preview.js",
];

/** Files copied verbatim (no JS to protect, or needed as-is at runtime). */
const STATIC_FILES = [
  "manifest.json",
  "config.json",
  "assets",
  "background/offscreen.html",
  "popup/popup.html",
  "popup/popup.css",
  "pages/preview.html",
  "pages/preview.css",
];

const OBFUSCATOR_OPTIONS = {
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 10,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  numbersToExpressions: true,
  simplify: true,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
};

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function bundleAndProtect(entry) {
  const outFile = join(OUT, entry);
  mkdirSync(dirname(outFile), { recursive: true });

  const result = await build({
    entryPoints: [join(ROOT, entry)],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome116",
    minify: true,
    legalComments: "none",
    write: false,
  });

  const minified = result.outputFiles[0].text;
  const protectedCode = obfuscator
    .obfuscate(minified, OBFUSCATOR_OPTIONS)
    .getObfuscatedCode();

  writeFileSync(outFile, protectedCode);
  log(`  bundled + obfuscated  ${entry}`);
}

function copyStatic() {
  for (const rel of STATIC_FILES) {
    cpSync(join(ROOT, rel), join(OUT, rel), { recursive: true });
    log(`  copied                ${rel}`);
  }
}

function zip(version) {
  const zipName = `doclink-${version}.zip`;
  // -r recurse, -X drop macOS extended attrs, run from dist/ so paths are relative.
  execFileSync("zip", ["-r", "-X", zipName, "doclink"], {
    cwd: DIST,
    stdio: "ignore",
  });
  return zipName;
}

async function main() {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "manifest.json"), "utf8"),
  );

  log(`Building DocLink ${manifest.version} -> dist/doclink/`);
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const entry of ENTRY_POINTS) {
    await bundleAndProtect(entry);
  }
  copyStatic();

  const zipName = zip(manifest.version);
  log("");
  log("Done.");
  log(`  Unpacked folder : dist/doclink/`);
  log(`  Zip to share    : dist/${zipName}`);
  log("");
  log("Tell the recipient: chrome://extensions -> Developer mode ON ->");
  log("Load unpacked -> pick the unzipped doclink/ folder.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
