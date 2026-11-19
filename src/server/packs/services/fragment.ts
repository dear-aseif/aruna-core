import { z } from "zod";
import type { PackDefinition } from "../registry";

/** Services Pack Playbook fragment: treatment catalog (duration, price) and confirmation template. Opening hours are a core field. */
const treatment = z.strictObject({
  name: z.string().trim().min(1),
  durationMinutes: z.number().int().positive(),
  /** Whole currency units. */
  price: z.number().int().nonnegative(),
});

const catalog = z
  .strictObject({ treatments: z.array(treatment).min(1) })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.treatments.forEach((t, i) => {
      const key = t.name.toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["treatments", i, "name"], message: "duplicate treatment name" });
      seen.add(key);
    });
  });

export type ServicesCatalog = z.infer<typeof catalog>;

export const servicesPack: PackDefinition = {
  id: "services",
  label: "Services Pack",
  fragment: {
    catalog,
    thresholds: {},
    templates: { bookingConfirmation: z.string().trim().min(1) },
  },
};
