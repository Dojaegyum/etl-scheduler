import { describe, expect, it, vi } from "vitest";
import { HttpError, isRetryableError, statusOf, withRetry, errorMessage } from "../src/retry.ts";

const noSleep = async () => {};

describe("statusOf / isRetryableError", () => {
  it("reads HttpError status", () => {
    expect(statusOf(new HttpError(503, "x"))).toBe(503);
    expect(isRetryableError(new HttpError(503, "x"))).toBe(true);
    expect(isRetryableError(new HttpError(429, "x"))).toBe(true);
    expect(isRetryableError(new HttpError(404, "x"))).toBe(false);
  });
  it("reads gaxios-style errors", () => {
    expect(statusOf({ response: { status: 500 } })).toBe(500);
    expect(statusOf({ code: "502" })).toBe(502);
    expect(statusOf({ code: 403 })).toBe(403);
    expect(statusOf({ code: "ECONNRESET" })).toBeUndefined();
  });
  it("treats network errors as retryable and plain errors as not", () => {
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns on first success", async () => {
    const fn = vi.fn(async () => 42);
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("retries retryable errors up to `retries` times with exponential delays", async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw new HttpError(500, "down");
    });
    await expect(
      withRetry(fn, {
        retries: 3,
        baseDelayMs: 10,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([10, 20, 40]);
  });
  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn(async () => {
      throw new HttpError(401, "nope");
    });
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("succeeds after a transient failure", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw new TypeError("fetch failed");
      return "ok";
    };
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
  });
});

describe("errorMessage", () => {
  it("extracts a message from anything", () => {
    expect(errorMessage(new Error("a"))).toBe("a");
    expect(errorMessage("b")).toBe("b");
    expect(errorMessage({ message: "c" })).toBe("c");
  });
});
