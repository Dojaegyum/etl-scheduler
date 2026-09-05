import { describe, expect, it } from "vitest";
import { receiveCodeViaLoopback } from "../src/auth.ts";

describe("receiveCodeViaLoopback", () => {
  it("opens a 127.0.0.1 port, resolves with the code from the callback", async () => {
    let uri = "";
    const pending = receiveCodeViaLoopback((redirectUri) => {
      uri = redirectUri;
    });
    // onReady는 listen 직후 호출되므로 한 틱 기다린다
    await new Promise((r) => setTimeout(r, 50));
    expect(uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${uri}/?code=abc123&scope=x`);
    expect(res.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: "abc123", redirectUri: uri });
  });
  it("rejects when Google returns an error", async () => {
    let uri = "";
    const pending = receiveCodeViaLoopback((redirectUri) => {
      uri = redirectUri;
    });
    await new Promise((r) => setTimeout(r, 50));
    // 거부 콜백이 도착하는 순간 이미 처리기가 붙어 있어야 unhandled rejection 경고가 없다
    const assertion = expect(pending).rejects.toThrow(/access_denied/);
    await fetch(`${uri}/?error=access_denied`);
    await assertion;
  });
});
