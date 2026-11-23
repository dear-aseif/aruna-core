import { describe, expect, it } from "vitest";
import { DEFAULT_BRIEFING_TIME, decideBriefing, localMoment, previousDate } from "@/server/routines/schedule";

describe("routine schedule (pure)", () => {
  it("is due exactly at the briefing time in the tenant's timezone, and not a second before", () => {
    // 07:30 in Asia/Makassar (UTC+8) is 23:30 UTC the previous day.
    const before = decideBriefing(new Date("2031-03-10T23:29:59Z"), "Asia/Makassar", "07:30");
    const at = decideBriefing(new Date("2031-03-10T23:30:00Z"), "Asia/Makassar", "07:30");
    expect(before).toMatchObject({ due: false, date: "2031-03-11", time: "07:29" });
    expect(at).toMatchObject({ due: true, date: "2031-03-11", time: "07:30" });
  });

  it("the same instant gives different local dates and due decisions in different timezones", () => {
    const now = new Date("2031-03-10T15:30:00Z");
    expect(decideBriefing(now, "Asia/Makassar", "07:30")).toMatchObject({ due: true, date: "2031-03-10", time: "23:30" });
    expect(decideBriefing(now, "Pacific/Honolulu", "07:30")).toMatchObject({ due: false, date: "2031-03-10", time: "05:30" });
    expect(decideBriefing(new Date("2031-03-10T23:30:00Z"), "Asia/Makassar", "07:30").date).toBe("2031-03-11");
  });

  it("a late invocation on the same local day is still due (catch-up); the next local day starts not due", () => {
    expect(decideBriefing(new Date("2031-03-11T05:00:00Z"), "Asia/Makassar", "07:30").due).toBe(true);
    expect(decideBriefing(new Date("2031-03-11T16:00:00Z"), "Asia/Makassar", "07:30")).toMatchObject({ due: false, date: "2031-03-12" });
  });

  it("applies the default time when the Playbook has none", () => {
    expect(decideBriefing(new Date("2031-03-10T05:59:00Z"), "UTC", undefined)).toMatchObject({ due: false, briefingTime: DEFAULT_BRIEFING_TIME });
    expect(decideBriefing(new Date("2031-03-10T06:00:00Z"), "UTC", undefined).due).toBe(true);
  });

  it("handles midnight as 00:00 and rejects an unknown timezone", () => {
    expect(localMoment(new Date("2031-03-10T00:00:00Z"), "UTC").time).toBe("00:00");
    expect(() => decideBriefing(new Date(), "Not/AZone", "06:00")).toThrow(RangeError);
  });

  it("previousDate crosses month and year boundaries", () => {
    expect(previousDate("2031-03-01")).toBe("2031-02-28");
    expect(previousDate("2032-01-01")).toBe("2031-12-31");
  });
});
