/**
 * Responsive / human-ergonomics coverage tests
 *
 * Locks down the mobile-first responsive refactor so future edits can't silently:
 *   - disable user scaling
 *   - leave the sidebar overlapping main content on mobile
 *   - shrink touch targets below the 44px mobile minimum
 *   - re-introduce inline styles that should be CSS classes
 *   - drop safe-area support for bottom nav
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const INDEX_HTML = readFileSync(join(ROOT, "public", "index.html"), "utf8");
const APP_JS = readFileSync(join(ROOT, "public", "app.js"), "utf8");
const CSS = INDEX_HTML.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";

/** Extract the body of the first @media (max-width: Npx) block using brace counting. */
function extractMediaBlock(css: string, maxWidth: number): string {
  const start = css.indexOf(`@media (max-width: ${maxWidth}px)`);
  if (start === -1) return "";
  let openIdx = css.indexOf("{", start);
  if (openIdx === -1) return "";
  let depth = 1;
  let i = openIdx + 1;
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return css.slice(openIdx + 1, i - 1);
}

const mobileBlock = () => extractMediaBlock(CSS, 768);
const tabletBlock = () => extractMediaBlock(CSS, 1024);

describe("Responsive HTML contract", () => {
  it("viewport allows user scaling", () => {
    const meta = INDEX_HTML.match(/<meta[^>]*name="viewport"[^>]*>/)?.[0] ?? "";
    expect(meta).toContain("width=device-width");
    expect(meta).toContain("initial-scale=1.0");
    expect(meta).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(meta).not.toMatch(/maximum-scale\s*=\s*1\.0/i);
  });

  it("contains mobile breakpoint that hides sidebar by default", () => {
    const block = mobileBlock();
    expect(block).not.toBe("");
    expect(block).toContain(".sidebar");
    expect(block).toMatch(/transform:\s*translateX\(\s*-100%\s*\)/);
    expect(block).toContain(".is-open");
  });

  it("contains tablet breakpoint for 769-1024px", () => {
    const block = tabletBlock();
    expect(block).not.toBe("");
    expect(block).toContain(".main");
    expect(block).toMatch(/--sidebar-w/);
  });

  it("has no inline style= attributes in HTML", () => {
    const matches = INDEX_HTML.match(/\sstyle\s*=\s*"[^"]*"/g) ?? [];
    expect(matches).toHaveLength(0);
  });

  it("bottom nav has safe-area inset support", () => {
    expect(CSS).toMatch(/env\(\s*safe-area-inset-bottom\s*(?:,\s*[^)]*)?\)/);
  });

  it("bottom nav items meet 44px touch target", () => {
    const bottomBlock = CSS.match(/\.bottom-nav-item\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(bottomBlock).toMatch(/min-height:\s*(4[4-9]|[5-9]\d)px/);
  });

  it("header controls are at least 44px", () => {
    expect(CSS).toMatch(/\.hamburger\s*\{[^}]*(?:width|min-width):\s*44px/);
    expect(CSS).toMatch(/\.theme-btn,\s*\.refresh-btn,\s*\.kbd-help-btn\s*\{[^}]*(?:width|min-width):\s*44px/);
  });

  it("main content has overflow safeguards", () => {
    expect(CSS).toContain(".main");
    expect(CSS).toMatch(/\.main\s*\{[^}]*min-width:\s*0/);
    expect(CSS).toMatch(/img,\s*svg\s*\{[^}]*max-width:\s*100%/);
  });

  it("data tables are wrapped for horizontal scroll on small screens", () => {
    expect(CSS).toContain(".data-table-wrapper");
    expect(CSS).toMatch(/\.data-table-wrapper\s*\{[^}]*overflow-x:\s*auto/);
  });

  it("cards and grids shrink on mobile", () => {
    const block = mobileBlock();
    expect(block).toContain("grid-template-columns: 1fr");
    expect(block).toContain("flex-direction: column");
  });

  it("refresh and keyboard-help buttons have IDs wired in app.js", () => {
    expect(INDEX_HTML).toContain('id="refreshBtn"');
    expect(INDEX_HTML).toContain('id="kbdHelpBtn"');
    expect(APP_JS).toContain("refreshBtn");
    expect(APP_JS).toContain("kbdHelpBtn");
  });
});

describe("Responsive CSS utility classes", () => {
  const classes = [
    ".card--compact",
    ".card--pad",
    ".card--highlight",
    ".card--error",
    ".card-header__title",
    ".chart-svg",
    ".chart-svg--lg",
    ".metric-lg",
    ".grid--2",
    ".gap-sm",
    ".gap-md",
    ".badge--lg",
    ".text-accent",
    ".text-success",
    ".text-purple",
    ".text-warn",
    ".text-danger",
    ".status-dot--connected",
    ".status-dot--disconnected",
    ".activity-item__dot--success",
    ".activity-item__dot--accent",
    ".activity-item__dot--purple",
    ".activity-item__dot--warn",
  ];

  for (const cls of classes) {
    it(`defines ${cls}`, () => {
      const re = new RegExp(`${cls.replace(/\./g, "\\.")}\\s*\\{`);
      expect(CSS).toMatch(re);
    });
  }
});

describe("app.js responsive ergonomics", () => {
  it("toggleSidebar checks mobile width", () => {
    expect(APP_JS).toMatch(/toggleSidebar\s*\(\s*\)\s*\{/);
    expect(APP_JS).toMatch(/innerWidth\s*<\s*=\s*768/);
    expect(APP_JS).toContain("'is-open'");
  });

  it("nativeIndicator uses CSS classes not inline color", () => {
    expect(APP_JS).toContain("nativeIndicator");
    expect(APP_JS).not.toMatch(/nativeIndicator\.style\.color/);
    expect(APP_JS).toContain("ts-core");
    expect(APP_JS).toContain("rust-core");
  });

  it("wsStatus uses CSS classes not inline background", () => {
    expect(APP_JS).not.toMatch(/status-dot.*style=.*background/);
    expect(APP_JS).toContain("status-dot--connected");
    expect(APP_JS).toContain("status-dot--disconnected");
  });
});
