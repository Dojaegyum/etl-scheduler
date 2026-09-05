import { describe, expect, it } from "vitest";
import type { DesiredEvent } from "../src/mapper.ts";
import { describePlan, isEmptyPlan, planSync, type ManagedEvent } from "../src/sync.ts";

function desired(key: string, hash: string): DesiredEvent {
  return {
    key,
    hash,
    summary: `S ${key}`,
    description: "",
    start: "2026-09-10T14:29:59.000Z",
    end: "2026-09-10T14:59:59.000Z",
    reminderMinutes: [1440],
  };
}
const managed = (id: string, key: string, hash: string): ManagedEvent => ({ id, key, hash });

describe("planSync", () => {
  it("inserts new, updates changed, skips same, deletes missing", () => {
    const plan = planSync(
      [desired("a", "h1"), desired("b", "h2-new"), desired("c", "h3")],
      [managed("id-b", "b", "h2-old"), managed("id-c", "c", "h3"), managed("id-d", "d", "h4")],
    );
    expect(plan.inserts.map((e) => e.key)).toEqual(["a"]);
    expect(plan.updates).toEqual([{ id: "id-b", event: desired("b", "h2-new") }]);
    expect(plan.deletes).toEqual([managed("id-d", "d", "h4")]);
  });
  it("is idempotent: same state yields empty plan", () => {
    const plan = planSync([desired("a", "h1")], [managed("id-a", "a", "h1")]);
    expect(isEmptyPlan(plan)).toBe(true);
  });
  it("keeps first duplicate managed event and deletes the rest", () => {
    const plan = planSync([desired("a", "h1")], [managed("id-1", "a", "h1"), managed("id-2", "a", "h1")]);
    expect(plan.deletes.map((m) => m.id)).toEqual(["id-2"]);
    expect(plan.updates).toEqual([]);
  });
  it("dedupes desired by key (last wins)", () => {
    const plan = planSync([desired("a", "h1"), desired("a", "h2")], []);
    expect(plan.inserts).toEqual([desired("a", "h2")]);
  });
});

describe("describePlan", () => {
  it("lists one line per change", () => {
    const plan = planSync(
      [desired("a", "h1"), desired("b", "h2")],
      [managed("id-b", "b", "old"), managed("id-z", "z", "h")],
    );
    expect(describePlan(plan)).toEqual([
      "+ S a (2026-09-10T14:59:59.000Z)",
      "~ S b (2026-09-10T14:59:59.000Z)",
      "- z",
    ]);
  });
});
