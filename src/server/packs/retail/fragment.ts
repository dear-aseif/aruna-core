import { z } from "zod";
import type { PackDefinition } from "../registry";

/** Retail Pack Playbook fragment: catalog with variants, low-stock threshold, follow-up template. */
const variant = z.strictObject({
  sku: z.string().trim().min(1),
  size: z.string().trim().min(1),
  /** Whole currency units (IDR has no minor unit in practice). */
  price: z.number().int().nonnegative(),
});

const product = z.strictObject({
  name: z.string().trim().min(1),
  variants: z.array(variant).min(1),
});

const catalog = z
  .strictObject({ products: z.array(product).min(1) })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.products.forEach((p, pi) =>
      p.variants.forEach((v, vi) => {
        if (seen.has(v.sku)) ctx.addIssue({ code: "custom", path: ["products", pi, "variants", vi, "sku"], message: "duplicate sku" });
        seen.add(v.sku);
      }),
    );
  });

export type RetailCatalog = z.infer<typeof catalog>;

export const retailPack: PackDefinition = {
  id: "retail",
  label: "Retail Pack",
  fragment: {
    catalog,
    thresholds: { lowStock: z.number().int().nonnegative() },
    templates: { supplierFollowUp: z.string().trim().min(1) },
  },
};
