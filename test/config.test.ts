import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseReminderMinutes, syncWindow, LOOKAHEAD_DAYS, LOOKBACK_DAYS } from "../src/config.ts";

const base = {
  CANVAS_PRIVATE_TOKEN: "tok",
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "csec",
};

describe("loadConfig", () => {
  it("applies defaults for optional values", () => {
    const c = loadConfig(base);
    expect(c.canvasBaseUrl).toBe("https://myetl.snu.ac.kr");
    expect(c.googleRefreshToken).toBeNull();
    expect(c.googleCalendarId).toBeNull();
    expect(c.reminderMinutes).toEqual([1440]);
  });

  it("strips trailing slash from CANVAS_BASE_URL", () => {
    expect(loadConfig({ ...base, CANVAS_BASE_URL: "https://x.test/" }).canvasBaseUrl).toBe("https://x.test");
  });

  it("throws ConfigError naming the missing variable", () => {
    expect(() => loadConfig({ ...base, CANVAS_PRIVATE_TOKEN: "  " })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, GOOGLE_CLIENT_ID: undefined })).toThrow(/GOOGLE_CLIENT_ID/);
  });
});

describe("parseReminderMinutes", () => {
  it("defaults to one day", () => {
    expect(parseReminderMinutes(undefined)).toEqual([1440]);
    expect(parseReminderMinutes("")).toEqual([1440]);
  });
  it("parses a comma list", () => {
    expect(parseReminderMinutes("1440, 60")).toEqual([1440, 60]);
  });
  it("rejects garbage", () => {
    expect(() => parseReminderMinutes("soon")).toThrow(ConfigError);
    expect(() => parseReminderMinutes("-5")).toThrow(ConfigError);
  });
});

describe("syncWindow", () => {
  it("spans lookback..lookahead around now", () => {
    const now = new Date("2026-09-06T00:00:00Z");
    const w = syncWindow(now);
    expect(w.start.toISOString()).toBe(new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString());
    expect(w.end.toISOString()).toBe(new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000).toISOString());
  });
});
