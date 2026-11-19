import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

describe("PWA manifest", () => {
  it("declares an installable standalone app", () => {
    const m = manifest();
    expect(m.name).toBe("Aruna");
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    expect(m.icons?.length).toBeGreaterThan(0);
  });
});
