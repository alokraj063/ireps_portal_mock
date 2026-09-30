/**
 * Where may DocLink run? (side panel tab scope)
 *
 * DocLink talks to exactly one IREPS portal: config.json's target (the mock
 * portal on localhost, or the real portal). The side panel therefore only
 * shows its tools on a tab of that portal; on any other tab it shows a
 * "go to IREPS and log in" page instead. classifyTabUrl() is that rule,
 * driven entirely by config.json (IREPS_CONFIG) - no URL is written here.
 *
 * manifest.json host_permissions are used for one thing only: to detect a
 * config.json that points at an origin the extension is not allowed to
 * call, which would otherwise fail silently as "Unavailable".
 *
 * Match patterns supported: `<all_urls>`, `scheme://host/path` where scheme
 * is `*` (http or https), http, https, file, ftp, ws or wss; host is `*`,
 * `*.example.com` (the domain and every subdomain) or an exact host with an
 * optional port. The path part is required but ignored (per-origin check).
 *
 * @see https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
 */

/** Result of classifyTabUrl(). */
export const TAB_SCOPE = Object.freeze({
  /** The tab is on the configured IREPS portal: show DocLink. */
  ACTIVE_PORTAL: "ACTIVE_PORTAL",
  /** The tab is on the other portal from config.json (mock vs real). */
  OTHER_PORTAL: "OTHER_PORTAL",
  /** Any other page (or a tab with no URL yet). */
  NOT_IREPS: "NOT_IREPS",
  /** config.json points at an origin missing from manifest host_permissions. */
  MISCONFIGURED: "MISCONFIGURED"
});

const SCHEMES = ["http", "https", "file", "ftp", "ws", "wss"];
const PATTERN = /^(\*|https?|file|ftp|wss?):\/\/(\*|\*\.[^/*:]+|[^/*]*)(\/.*)$/;

/**
 * @param {string} pattern   one match pattern, e.g. "http://localhost:8765/*"
 * @returns {((url: URL) => boolean) | null}   null when the pattern is invalid
 */
export function compileMatchPattern(pattern) {
  if (typeof pattern !== "string") return null;
  if (pattern === "<all_urls>") return (url) => SCHEMES.includes(url.protocol.replace(/:$/, ""));
  const m = PATTERN.exec(pattern);
  if (!m) return null;
  const [, scheme, host] = m;
  if (scheme !== "file" && host === "") return null;

  const schemeOk = scheme === "*" ? (p) => p === "http:" || p === "https:" : (p) => p === `${scheme}:`;

  let hostOk;
  if (host === "*") {
    hostOk = () => true;
  } else if (host.startsWith("*.")) {
    const suffix = host.slice(2).toLowerCase();
    hostOk = (url) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`);
  } else {
    const exact = host.toLowerCase();
    // "localhost:8765" must match the port; "www.ireps.gov.in" matches any port.
    hostOk = exact.includes(":") ? (url) => url.host === exact : (url) => url.hostname === exact;
  }
  return (url) => schemeOk(url.protocol) && hostOk(url);
}

/**
 * @param {readonly string[]} patterns   e.g. manifest.host_permissions
 * @returns {(url: string|undefined|null) => boolean}   true when the URL matches any pattern
 */
export function compileMatchPatterns(patterns) {
  const tests = (Array.isArray(patterns) ? patterns : []).map(compileMatchPattern).filter(Boolean);
  return (url) => {
    if (!url || tests.length === 0) return false;
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      return false;
    }
    parsed.hostname = parsed.hostname.toLowerCase();
    return tests.some((test) => test(parsed));
  };
}

/** @returns {string|null} "scheme://host[:port]" or null for anything that is not an absolute URL. */
export function originOf(url) {
  if (!url) return null;
  try {
    const origin = new URL(String(url)).origin;
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Decide what the side panel shows for a tab.
 *
 * @param {string|undefined|null} tabUrl
 * @param {{ baseUrl: string, target: string, portals: { mock: string, real: string } }} config   IREPS_CONFIG
 * @param {readonly string[]} hostPermissions   manifest.json host_permissions
 * @returns {{ scope: string, target: string, portalUrl: string, otherPortal: ("mock"|"real"|null) }}
 */
export function classifyTabUrl(tabUrl, config, hostPermissions) {
  const result = { scope: TAB_SCOPE.NOT_IREPS, target: config.target, portalUrl: config.baseUrl, otherPortal: null };
  if (!compileMatchPatterns(hostPermissions)(config.baseUrl)) {
    result.scope = TAB_SCOPE.MISCONFIGURED;
    return result;
  }
  const tabOrigin = originOf(tabUrl);
  if (!tabOrigin) return result;
  if (tabOrigin === originOf(config.baseUrl)) {
    result.scope = TAB_SCOPE.ACTIVE_PORTAL;
    return result;
  }
  for (const name of ["mock", "real"]) {
    if (tabOrigin === originOf(config.portals && config.portals[name])) {
      result.scope = TAB_SCOPE.OTHER_PORTAL;
      result.otherPortal = name;
      return result;
    }
  }
  return result;
}
