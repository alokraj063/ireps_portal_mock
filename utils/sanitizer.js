/**
 * HTML sanitisation helpers.
 *
 * IREPS HTML is untrusted input. DocLink never renders the IREPS page
 * directly; it extracts text out of a parsed DOM and rebuilds its own
 * markup from escaped strings. The helpers here support that approach:
 *
 *  - escapeHtml()           : escape a string for safe insertion into HTML
 *  - normaliseText()        : collapse whitespace / NBSP in extracted text
 *  - stripDangerousNodes()  : remove script/style/iframe/... from a Document
 *  - sanitiseFragment()     : defensive cleaner for any HTML fragment that
 *                             must be rendered (kept for the preview fallback;
 *                             the PDF path never renders IREPS markup)
 */

const DANGEROUS_TAGS = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "link",
  "meta",
  "base",
  "noscript",
  "template",
  "svg",
  "math",
  "canvas",
  "audio",
  "video",
  "img",
  "nav",
  "header",
  "footer",
  "menu"
];

const URL_ATTRIBUTES = ["href", "src", "action", "formaction", "xlink:href", "data", "poster"];

/**
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Collapse runs of whitespace and NBSP into single spaces and trim.
 * Business values are otherwise left untouched.
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function normaliseText(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(/ /g, " ")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Remove nodes that can execute code, load remote resources or that are
 * clearly not data (navigation, form controls, media). Also strips inline
 * event handlers and javascript: URLs from the remaining elements.
 * @param {Document|Element} root
 */
export function stripDangerousNodes(root) {
  if (!root || typeof root.querySelectorAll !== "function") return root;
  for (const node of Array.from(root.querySelectorAll(DANGEROUS_TAGS.join(",")))) {
    node.remove();
  }
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes || [])) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRIBUTES.includes(name) && /^\s*(javascript|data|vbscript):/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return root;
}

/**
 * Sanitise an arbitrary HTML fragment into a safe string. Only a small
 * whitelist of structural tags survives; everything else is unwrapped to
 * its text content and every attribute is dropped. Requires DOMParser.
 *
 * @param {string} html
 * @param {{ DOMParser?: typeof DOMParser }} [env]
 * @returns {string}
 */
export function sanitiseFragment(html, env = {}) {
  const Parser = env.DOMParser || globalThis.DOMParser;
  if (!Parser) throw new Error("DOMParser is not available in this context");
  const ALLOWED = new Set([
    "div", "p", "span", "br", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "h1", "h2", "h3", "h4", "strong", "b", "em", "i", "ul", "ol", "li", "section"
  ]);
  const doc = new Parser().parseFromString(`<body>${html}</body>`, "text/html");
  stripDangerousNodes(doc);

  const clean = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 8) {
        child.remove();
      } else if (child.nodeType === 1) {
        const tag = child.tagName.toLowerCase();
        if (!ALLOWED.has(tag)) {
          child.replaceWith(doc.createTextNode(child.textContent || ""));
          continue;
        }
        for (const attr of Array.from(child.attributes)) {
          child.removeAttribute(attr.name);
        }
        clean(child);
      }
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}
