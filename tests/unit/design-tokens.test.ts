import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Task 9.1 gate fix: components consume theme tokens (src/app/globals.css @theme), never raw palette values.
function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}
const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const FORBIDDEN: [string, RegExp][] = [
  ["palette class", new RegExp(`\\b[a-z:-]*(${PALETTE})-\\d{2,3}\\b`)],
  ["white/black", /\b(bg|text|border|ring|fill|stroke)-(white|black)\b/],
  ["raw font size", /\btext-(xs|sm|base|lg|xl|\d+xl)\b/],
  ["arbitrary value", /\b[a-z-]+-\[[^\]]+\]/],
  ["hex colour", /#[0-9a-fA-F]{3,8}\b/],
];

describe("design tokens", () => {
  it("defines the tokens in globals.css @theme", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    for (const t of ["--color-primary", "--color-ink", "--color-surface", "--spacing-gutter", "--text-body", "--text-caption"]) {
      expect(css).toContain(t);
    }
  });
  it("keeps the PWA themeColor in step with --color-primary", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const primary = css.match(/--color-primary:\s*(#[0-9a-fA-F]+)/)?.[1];
    expect(readFileSync("src/app/layout.tsx", "utf8")).toContain(`themeColor: "${primary}"`);
  });
  it.each(files("src"))("%s uses no raw palette, size or colour literals", (f) => {
    const src = readFileSync(f, "utf8");
    for (const [name, re] of FORBIDDEN) {
      // The PWA themeColor in the root layout is metadata (it cannot read a CSS variable); it must equal --color-primary.
      if (name === "hex colour" && f.endsWith("src/app/layout.tsx")) continue;
      expect(src.match(re)?.[0], `${f}: ${name}`).toBeUndefined();
    }
  });
});
