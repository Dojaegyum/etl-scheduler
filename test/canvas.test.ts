import { describe, expect, it, vi } from "vitest";
import { CanvasAuthError, fetchPlannerItems, normalizeItem, parseNextLink, type PlannerItem } from "../src/canvas.ts";

const config = { canvasToken: "tok", canvasBaseUrl: "https://lms.test" };
const window = { start: new Date("2026-09-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") };

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const assignment: PlannerItem = {
  plannable_type: "assignment",
  plannable_id: 375398,
  course_id: 306086,
  context_name: "2026-2 전기·정보세미나 3 (001)",
  plannable_date: "2026-09-10T14:59:59Z",
  html_url: "/courses/306086/assignments/375398",
  submissions: { submitted: false },
  plannable: { title: "2주차 소감문 제출", due_at: "2026-09-10T14:59:59Z", points_possible: 0 },
};

describe("parseNextLink", () => {
  it("finds rel=next among several links", () => {
    const header =
      '<https://lms.test/api/v1/planner/items?page=first>; rel="current",<https://lms.test/api/v1/planner/items?page=2>; rel="next",<https://lms.test/x?page=first>; rel="first"';
    expect(parseNextLink(header)).toBe("https://lms.test/api/v1/planner/items?page=2");
  });
  it("returns null without next", () => {
    expect(parseNextLink('<https://a>; rel="current"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("normalizeItem", () => {
  it("normalizes an assignment", () => {
    expect(normalizeItem(assignment, config.canvasBaseUrl)).toEqual({
      key: "assignment:375398",
      courseId: 306086,
      courseName: "2026-2 전기·정보세미나 3 (001)",
      title: "2주차 소감문 제출",
      dueAt: "2026-09-10T14:59:59.000Z",
      url: "https://lms.test/courses/306086/assignments/375398",
      submitted: false,
      pointsPossible: 0,
    });
  });
  it("reads submitted=true and submissions=false", () => {
    expect(normalizeItem({ ...assignment, submissions: { submitted: true } }, config.canvasBaseUrl)?.submitted).toBe(true);
    expect(normalizeItem({ ...assignment, submissions: false }, config.canvasBaseUrl)?.submitted).toBe(false);
  });
  it("drops unsupported types and items without a due date", () => {
    expect(normalizeItem({ ...assignment, plannable_type: "calendar_event" }, config.canvasBaseUrl)).toBeNull();
    expect(
      normalizeItem({ ...assignment, plannable_date: null, plannable: { title: "x", due_at: null } }, config.canvasBaseUrl),
    ).toBeNull();
  });
  it("falls back to plannable.due_at and keeps quiz/discussion", () => {
    const quiz: PlannerItem = {
      ...assignment,
      plannable_type: "quiz",
      plannable_id: 7,
      plannable_date: undefined,
      plannable: { title: "퀴즈", due_at: "2026-09-12T00:00:00Z" },
    };
    expect(normalizeItem(quiz, config.canvasBaseUrl)?.key).toBe("quiz:7");
    expect(normalizeItem({ ...assignment, plannable_type: "discussion_topic" }, config.canvasBaseUrl)?.key).toBe(
      "discussion_topic:375398",
    );
  });
});

describe("fetchPlannerItems", () => {
  it("sends bearer token and window, follows Link next, filters items", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
      if (url.includes("page=2")) return json([{ ...assignment, plannable_id: 2 }]);
      return json([assignment, { ...assignment, plannable_type: "announcement" }], {
        link: `<${config.canvasBaseUrl}/api/v1/planner/items?page=2>; rel="next"`,
      });
    }) as unknown as typeof fetch;

    const items = await fetchPlannerItems(config, window, fetchImpl);
    expect(items.map((i) => i.key)).toEqual(["assignment:375398", "assignment:2"]);
    const first = new URL(calls[0]!);
    expect(first.pathname).toBe("/api/v1/planner/items");
    expect(first.searchParams.get("start_date")).toBe(window.start.toISOString());
    expect(first.searchParams.get("end_date")).toBe(window.end.toISOString());
    expect(first.searchParams.get("per_page")).toBe("50");
    expect(calls).toHaveLength(2);
  });
  it("throws CanvasAuthError on 401 without retrying", async () => {
    const fetchImpl = vi.fn(async () => json({ errors: [{ message: "사용자 인증 필요" }] }, {}, 401)) as unknown as typeof fetch;
    await expect(fetchPlannerItems(config, window, fetchImpl)).rejects.toBeInstanceOf(CanvasAuthError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
