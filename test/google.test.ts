import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/config.ts";
import type { DesiredEvent } from "../src/mapper.ts";
import {
  applyPlan,
  createGoogleClient,
  findOrCreateCalendar,
  fromGoogleEvent,
  listManagedEvents,
  toGoogleEventBody,
  type CalendarApi,
} from "../src/google.ts";

const event: DesiredEvent = {
  key: "assignment:1",
  hash: "abc",
  summary: "[과목] 과제",
  description: "d",
  start: "2026-09-10T14:29:59.000Z",
  end: "2026-09-10T14:59:59.000Z",
  reminderMinutes: [1440],
};
const window = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") };

describe("toGoogleEventBody / fromGoogleEvent", () => {
  it("maps fields, reminders and private properties", () => {
    const body = toGoogleEventBody(event);
    expect(body.summary).toBe("[과목] 과제");
    expect(body.start).toEqual({ dateTime: event.start, timeZone: "Asia/Seoul" });
    expect(body.end).toEqual({ dateTime: event.end, timeZone: "Asia/Seoul" });
    expect(body.reminders).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 1440 }] });
    expect(body.extendedProperties?.private).toEqual({ etlKey: "assignment:1", etlHash: "abc", etlVersion: "1" });
  });
  it("sends empty overrides when no reminders", () => {
    expect(toGoogleEventBody({ ...event, reminderMinutes: [] }).reminders).toEqual({ useDefault: false, overrides: [] });
  });
  it("round-trips managed metadata and ignores foreign events", () => {
    expect(fromGoogleEvent({ id: "g1", extendedProperties: { private: { etlKey: "assignment:1", etlHash: "abc" } } })).toEqual({
      id: "g1",
      key: "assignment:1",
      hash: "abc",
    });
    expect(fromGoogleEvent({ id: "g2", summary: "생일" })).toBeNull();
  });
});

describe("createGoogleClient", () => {
  it("requires a refresh token", () => {
    expect(() =>
      createGoogleClient({
        canvasToken: "t",
        canvasBaseUrl: "https://x",
        googleClientId: "id",
        googleClientSecret: "s",
        googleRefreshToken: null,
        googleCalendarId: null,
        reminderMinutes: [1440],
      }),
    ).toThrow(ConfigError);
  });
});

function fakeApi(overrides: Record<string, unknown>): CalendarApi {
  return overrides as unknown as CalendarApi;
}

describe("findOrCreateCalendar", () => {
  it("uses configured id when it exists", async () => {
    const get = vi.fn(async () => ({ data: { id: "cal-1" } }));
    const api = fakeApi({ calendars: { get } });
    await expect(findOrCreateCalendar(api, "cal-1")).resolves.toEqual({ id: "cal-1", created: false });
    expect(get).toHaveBeenCalledWith({ calendarId: "cal-1" });
  });
  it("explains a missing configured id", async () => {
    const api = fakeApi({
      calendars: {
        get: vi.fn(async () => {
          throw { response: { status: 404 } };
        }),
      },
    });
    await expect(findOrCreateCalendar(api, "gone")).rejects.toThrow(/GOOGLE_CALENDAR_ID/);
  });
  it("finds by name, else creates", async () => {
    const list = vi.fn(async () => ({
      data: {
        items: [
          { id: "other", summary: "휴가" },
          { id: "cal-etl", summary: "eTL 과제" },
        ],
      },
    }));
    const api = fakeApi({ calendarList: { list } });
    await expect(findOrCreateCalendar(api, null)).resolves.toEqual({ id: "cal-etl", created: false });

    const insert = vi.fn(async () => ({ data: { id: "cal-new" } }));
    const api2 = fakeApi({ calendarList: { list: vi.fn(async () => ({ data: { items: [] } })) }, calendars: { insert } });
    await expect(findOrCreateCalendar(api2, null)).resolves.toEqual({ id: "cal-new", created: true });
    expect(insert).toHaveBeenCalledWith({
      requestBody: expect.objectContaining({ summary: "eTL 과제", timeZone: "Asia/Seoul" }),
    });
  });
});

describe("listManagedEvents", () => {
  it("pages through results and keeps only managed events", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          items: [{ id: "g1", extendedProperties: { private: { etlKey: "a", etlHash: "h" } } }, { id: "x" }],
          nextPageToken: "p2",
        },
      })
      .mockResolvedValueOnce({
        data: { items: [{ id: "g2", extendedProperties: { private: { etlKey: "b", etlHash: "h" } } }] },
      });
    const api = fakeApi({ events: { list } });
    const out = await listManagedEvents(api, "cal", window);
    expect(out.map((m) => m.id)).toEqual(["g1", "g2"]);
    expect(list.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        calendarId: "cal",
        privateExtendedProperty: ["etlVersion=1"],
        singleEvents: true,
        maxResults: 2500,
        timeMin: window.start.toISOString(),
        timeMax: window.end.toISOString(),
      }),
    );
    expect(list.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ pageToken: "p2" }));
  });
});

describe("applyPlan", () => {
  it("inserts, updates, deletes and collects failures without stopping", async () => {
    const insert = vi.fn(async () => ({ data: {} }));
    const update = vi.fn(async () => {
      throw new Error("quota");
    });
    const del = vi.fn(async () => {
      throw { response: { status: 410 } };
    });
    const api = fakeApi({ events: { insert, update, delete: del } });
    const lines: string[] = [];
    const result = await applyPlan(
      api,
      "cal",
      {
        inserts: [event],
        updates: [{ id: "g1", event: { ...event, key: "assignment:2" } }],
        deletes: [{ id: "g9", key: "assignment:9", hash: "h" }],
      },
      (l) => lines.push(l),
    );
    expect(insert).toHaveBeenCalledWith({ calendarId: "cal", requestBody: toGoogleEventBody(event) });
    expect(update).toHaveBeenCalledWith({
      calendarId: "cal",
      eventId: "g1",
      requestBody: toGoogleEventBody({ ...event, key: "assignment:2" }),
    });
    expect(del).toHaveBeenCalledWith({ calendarId: "cal", eventId: "g9" });
    expect(result.ok).toBe(2); // insert + delete(410은 이미 없음 → 성공 취급)
    expect(result.failures).toEqual([{ action: "update", key: "assignment:2", error: "quota" }]);
    expect(lines).toEqual(["+ [과목] 과제", "- assignment:9"]);
  });
});
