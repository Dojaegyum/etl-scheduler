import { describe, expect, it } from "vitest";
import type { EtlItem } from "../src/canvas.ts";
import { formatKst, shortCourseName, toDesiredEvent } from "../src/mapper.ts";

const item: EtlItem = {
  key: "assignment:375398",
  courseId: 306086,
  courseName: "2026-2 전기·정보세미나 3 (001)",
  title: "2주차 소감문 제출",
  dueAt: "2026-09-10T14:59:59.000Z",
  url: "https://myetl.snu.ac.kr/courses/306086/assignments/375398",
  submitted: false,
  pointsPossible: 10,
};

describe("shortCourseName", () => {
  it("strips semester prefix and section suffix", () => {
    expect(shortCourseName("2026-2 전기·정보세미나 3 (001)")).toBe("전기·정보세미나 3");
    expect(shortCourseName("2026-3 (공유)반도체소자 (001)")).toBe("(공유)반도체소자");
  });
  it("leaves names without those parts alone", () => {
    expect(shortCourseName("디지털 시스템 설계")).toBe("디지털 시스템 설계");
    expect(shortCourseName("")).toBe("");
  });
});

describe("formatKst", () => {
  it("renders Korean date with weekday in Asia/Seoul", () => {
    expect(formatKst("2026-09-10T14:59:59Z")).toBe("2026-09-10 (목) 23:59");
    expect(formatKst("2026-09-10T15:00:00Z")).toBe("2026-09-11 (금) 00:00");
  });
});

describe("toDesiredEvent", () => {
  it("builds summary, 30-minute block, description, reminders", () => {
    const e = toDesiredEvent(item, [1440, 60]);
    expect(e.key).toBe("assignment:375398");
    expect(e.summary).toBe("[전기·정보세미나 3] 2주차 소감문 제출");
    expect(e.start).toBe("2026-09-10T14:29:59.000Z");
    expect(e.end).toBe("2026-09-10T14:59:59.000Z");
    expect(e.reminderMinutes).toEqual([1440, 60]);
    expect(e.description.split("\n")).toEqual([
      "2026-2 전기·정보세미나 3 (001)",
      "마감: 2026-09-10 (목) 23:59 KST",
      "배점: 10점",
      "상태: 미제출",
      "https://myetl.snu.ac.kr/courses/306086/assignments/375398",
    ]);
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("marks submitted items and drops reminders", () => {
    const e = toDesiredEvent({ ...item, submitted: true, pointsPossible: null }, [1440]);
    expect(e.summary).toBe("✅ [전기·정보세미나 3] 2주차 소감문 제출");
    expect(e.reminderMinutes).toEqual([]);
    expect(e.description).not.toContain("배점");
    expect(e.description).toContain("상태: 제출완료");
  });
  it("hash is stable for same input and changes with any field", () => {
    const a = toDesiredEvent(item, [1440]);
    const b = toDesiredEvent({ ...item }, [1440]);
    expect(a.hash).toBe(b.hash);
    expect(toDesiredEvent(item, [60]).hash).not.toBe(a.hash);
    expect(toDesiredEvent({ ...item, title: "x" }, [1440]).hash).not.toBe(a.hash);
  });
});
