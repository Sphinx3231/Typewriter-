import { describe, expect, it } from "vitest";
import { clockDuration, dateTime, longDuration, nf, timeOfDay } from "./format";

describe("clockDuration", () => {
  it("formats m:ss under an hour and h:mm:ss above", () => {
    expect(clockDuration(0)).toBe("0:00");
    expect(clockDuration(7000)).toBe("0:07");
    expect(clockDuration(245_000)).toBe("4:05");
    expect(clockDuration(3_599_000)).toBe("59:59");
    expect(clockDuration(3_600_000)).toBe("1:00:00");
    expect(clockDuration(3_723_000)).toBe("1:02:03");
    expect(clockDuration(36_000_000 + 61_000)).toBe("10:01:01");
  });

  it("rounds to the nearest second and never goes negative", () => {
    expect(clockDuration(1499)).toBe("0:01");
    expect(clockDuration(1500)).toBe("0:02");
    expect(clockDuration(59_500)).toBe("1:00");
    expect(clockDuration(-5000)).toBe("0:00");
  });
});

describe("longDuration", () => {
  it("uses seconds, minutes and hours as appropriate", () => {
    expect(longDuration(0)).toBe("0 s");
    expect(longDuration(45_000)).toBe("45 s");
    expect(longDuration(59_400)).toBe("59 s");
    expect(longDuration(60_000)).toBe("1 min");
    expect(longDuration(180_000)).toBe("3 min");
    expect(longDuration(200_000)).toBe("3 min 20 s");
    expect(longDuration(3_900_000)).toBe("1 h 05 min");
    expect(longDuration(3_600_000 + 59_000)).toBe("1 h 00 min"); // seconds are dropped above an hour
    expect(longDuration(-1)).toBe("0 s");
  });
});

describe("timeOfDay and dateTime", () => {
  it("shows hours and two-digit minutes", () => {
    const s = timeOfDay(new Date(2026, 9, 17, 14, 5));
    expect(s).toMatch(/05/);
    expect(s).toMatch(/(14|2)/);
    expect(s).not.toMatch(/2026/);
  });

  it("formats a valid ISO timestamp with the date and year", () => {
    const iso = new Date(2026, 9, 17, 9, 30).toISOString();
    const s = dateTime(iso);
    expect(s).toMatch(/2026/);
    expect(s).toMatch(/17/);
    expect(s).toMatch(/30/);
  });

  it("returns an empty string for an invalid timestamp", () => {
    expect(dateTime("not a date")).toBe("");
    expect(dateTime("")).toBe("");
  });
});

describe("nf", () => {
  it("formats numbers with grouping", () => {
    const formatted = nf.format(1234567);
    expect(formatted.replace(/\D/g, "")).toBe("1234567");
    expect(formatted.length).toBeGreaterThan(7);
  });
});
