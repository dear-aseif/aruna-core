import { describe, expect, it } from "vitest";
import { numberEquality, readPath, recipientMatch, requiredFields } from "@/server/checker";

// Synthetic records only.
const sources = { po: { ref: "PO-0001", line: { quantity: 12, unitPrice: 85000 } }, supplier: { name: "CV Contoh Seragam" } };

describe("requiredFields", () => {
  const rule = requiredFields("req", ["item", "qty", "note.text"]);
  it("passes when all fields are present", () => {
    expect(rule.check({ fields: { item: "Kemeja SD", qty: 0, note: { text: "x" } }, sources: {} })).toEqual([]);
  });
  it("fails per missing, null, blank or empty-array field, naming each", () => {
    const out = rule.check({ fields: { item: "  ", qty: null, note: {} }, sources: {} });
    expect(out.map((a) => a.field)).toEqual(["item", "qty", "note.text"]);
    expect(rule.check({ fields: { item: [], qty: 1, note: { text: "x" } }, sources: {} })).toHaveLength(1);
  });
});

describe("numberEquality", () => {
  const rule = numberEquality("num", [
    { field: "quantity", source: "po.line.quantity" },
    { field: "price", source: "po.line.unitPrice" },
  ]);
  it("passes when draft numbers equal the source numbers", () => {
    expect(rule.check({ fields: { quantity: 12, price: 85000 }, sources })).toEqual([]);
  });
  it("fails with the exact mismatch", () => {
    const out = rule.check({ fields: { quantity: 13, price: 85000 }, sources });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rule: "num", field: "quantity" });
    expect(out[0].message).toContain("13");
    expect(out[0].message).toContain("12");
  });
  it("fails for a non-number draft value and for a missing source value", () => {
    expect(rule.check({ fields: { quantity: "12", price: 85000 }, sources })).toHaveLength(1);
    expect(rule.check({ fields: { quantity: 12, price: 85000 }, sources: {} })).toHaveLength(2);
    expect(rule.check({ fields: { quantity: Number.NaN, price: 85000 }, sources })).toHaveLength(1);
  });
});

describe("recipientMatch", () => {
  const rule = recipientMatch("rcpt", { field: "to", source: "supplier.name" });
  it("passes on a match, ignoring case and surrounding whitespace", () => {
    expect(rule.check({ fields: { to: "  cv contoh   seragam " }, sources })).toEqual([]);
  });
  it("fails on a different recipient, a missing recipient, and a missing source", () => {
    expect(rule.check({ fields: { to: "CV Lain" }, sources })[0].message).toContain("does not match");
    expect(rule.check({ fields: {}, sources })).toHaveLength(1);
    expect(rule.check({ fields: { to: "CV Contoh Seragam" }, sources: {} })).toHaveLength(1);
  });
});

describe("readPath", () => {
  it("reads own properties only", () => {
    expect(readPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(readPath({}, "constructor")).toBeUndefined();
    expect(readPath({ a: 1 }, "a.b")).toBeUndefined();
  });
});
