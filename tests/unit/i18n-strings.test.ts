import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LANGUAGES, STRINGS, navLabel } from "@/i18n/strings";

// Task 9.1 gate fix: one bilingual strings table, both languages complete.
describe("strings table", () => {
  it("has identical keys in every language and no empty values", () => {
    const base = Object.keys(STRINGS.en).sort();
    for (const l of LANGUAGES) {
      expect(Object.keys(STRINGS[l]).sort()).toEqual(base);
      for (const [k, v] of Object.entries(STRINGS[l])) expect(v.trim().length, `${l}:${k}`).toBeGreaterThan(0);
    }
  });
  it("translates the nav and falls back to the server label for unknown screens", () => {
    expect(navLabel("en", { id: "services:bookings", label: "Bookings" })).toBe("Bookings");
    expect(navLabel("id", { id: "services:bookings", label: "Bookings" })).toBe(STRINGS.id["nav.bookings"]);
    expect(navLabel("id", { id: "x:unknown", label: "Whatever" })).toBe("Whatever");
  });
});

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("no hard-coded UI strings in the shell, layout or placeholder pages", () => {
  // JSX text nodes with letters, between > and <, outside braces.
  const targets = [
    ...files("src/components"),
    "src/app/(workspace)/layout.tsx",
    ...files("src/app/(workspace)").filter((f) => f.endsWith("page.tsx")),
  ];
  it.each(targets)("%s", (f) => {
    const src = readFileSync(f, "utf8");
    const text = [...src.matchAll(/<[A-Za-z][^<>]*[^=<>]>([^<>{}]*[A-Za-z][^<>{}]*)<\/?[A-Za-z]/g)].map((m) => m[1].trim()).filter(Boolean);
    expect(text).toEqual([]);
    expect(src).not.toMatch(/\b(aria-label|placeholder|title|alt)="[^"{]*[A-Za-z]/);
  });
});
