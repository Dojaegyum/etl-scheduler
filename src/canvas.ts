import type { Config, SyncWindow } from "./config.ts";
import { HttpError, withRetry } from "./retry.ts";

export type EtlItem = {
  key: string;
  courseId: number;
  courseName: string;
  title: string;
  dueAt: string;
  url: string;
  submitted: boolean;
  pointsPossible: number | null;
};

export type PlannerItem = {
  plannable_type: string;
  plannable_id: number;
  course_id?: number;
  context_name?: string;
  plannable_date?: string | null;
  html_url?: string;
  submissions?: false | { submitted?: boolean };
  plannable?: { title?: string; name?: string; due_at?: string | null; points_possible?: number | null };
};

export type FetchLike = typeof fetch;

export class CanvasAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasAuthError";
  }
}

const INCLUDED_TYPES = new Set(["assignment", "quiz", "discussion_topic"]);

export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function normalizeItem(raw: PlannerItem, baseUrl: string): EtlItem | null {
  if (!INCLUDED_TYPES.has(raw.plannable_type)) return null;
  const due = raw.plannable_date ?? raw.plannable?.due_at ?? null;
  if (!due) return null;
  const submissions = raw.submissions;
  return {
    key: `${raw.plannable_type}:${raw.plannable_id}`,
    courseId: raw.course_id ?? 0,
    courseName: raw.context_name ?? "",
    title: raw.plannable?.title ?? raw.plannable?.name ?? "(제목 없음)",
    dueAt: new Date(due).toISOString(),
    url: raw.html_url ? new URL(raw.html_url, baseUrl).toString() : baseUrl,
    submitted: typeof submissions === "object" && submissions !== null && submissions.submitted === true,
    pointsPossible: raw.plannable?.points_possible ?? null,
  };
}

export async function fetchPlannerItems(
  config: Pick<Config, "canvasToken" | "canvasBaseUrl">,
  window: SyncWindow,
  fetchImpl: FetchLike = fetch,
): Promise<EtlItem[]> {
  const first = new URL("/api/v1/planner/items", config.canvasBaseUrl);
  first.searchParams.set("start_date", window.start.toISOString());
  first.searchParams.set("end_date", window.end.toISOString());
  first.searchParams.set("per_page", "50");

  const items: EtlItem[] = [];
  let next: string | null = first.toString();
  while (next) {
    const url: string = next;
    const res = await withRetry(async () => {
      const r = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${config.canvasToken}`, Accept: "application/json" },
      });
      if (r.status === 401) {
        throw new CanvasAuthError(
          "Canvas 토큰이 거부되었습니다(401). myetl 설정 → 승인된 통합에서 새 토큰을 발급해 CANVAS_PRIVATE_TOKEN을 갱신하세요.",
        );
      }
      if (!r.ok) throw new HttpError(r.status, `Canvas 요청 실패 ${r.status}: ${url}`);
      return r;
    });
    const page = (await res.json()) as PlannerItem[];
    for (const raw of page) {
      const item = normalizeItem(raw, config.canvasBaseUrl);
      if (item) items.push(item);
    }
    next = parseNextLink(res.headers.get("link"));
  }
  return items;
}
