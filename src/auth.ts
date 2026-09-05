import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { calendar } from "@googleapis/calendar";
import { GOOGLE_SCOPE, type Config } from "./config.ts";
import { createOAuthClient, findOrCreateCalendar } from "./google.ts";

export function receiveCodeViaLoopback(
  onReady: (redirectUri: string) => void | Promise<void>,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (!code && !error) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(code ? "<h2>인증 완료. 이 창을 닫고 터미널로 돌아가세요.</h2>" : `<h2>인증 실패: ${error}</h2>`);
      server.close();
      if (code) resolve({ code, redirectUri });
      else reject(new Error(`Google 인증이 거부되었습니다: ${error}`));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("로컬 콜백 포트를 열 수 없습니다."));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}`;
      Promise.resolve(onReady(redirectUri)).catch(reject);
    });
  });
}

export function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // cmd의 & 해석을 피하려고 URL을 따옴표로 감싼 채 그대로 넘긴다
      spawn("cmd.exe", ["/c", "start", '""', `"${url}"`], {
        windowsVerbatimArguments: true,
        stdio: "ignore",
        detached: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // 브라우저를 못 열어도 URL은 터미널에 출력되므로 사용자가 직접 열 수 있다
  }
}

export async function runAuth(
  config: Pick<Config, "googleClientId" | "googleClientSecret" | "googleCalendarId">,
  opts: { log: (line: string) => void; openBrowser?: (url: string) => void },
): Promise<{ refreshToken: string; calendarId: string }> {
  const open = opts.openBrowser ?? openBrowser;
  const { code, redirectUri } = await receiveCodeViaLoopback((uri) => {
    const oauth = createOAuthClient(config.googleClientId, config.googleClientSecret, uri);
    const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [GOOGLE_SCOPE] });
    opts.log("브라우저가 열립니다. 알림을 받을 Google 계정으로 로그인해 허용하세요.");
    opts.log(`브라우저가 안 열리면 이 주소를 직접 여세요:\n${url}\n`);
    open(url);
  });

  const oauth = createOAuthClient(config.googleClientId, config.googleClientSecret, redirectUri);
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "refresh token을 받지 못했습니다. Google 계정 → 보안 → 서드파티 앱에서 이 앱의 접근을 삭제한 뒤 다시 실행하세요.",
    );
  }
  oauth.setCredentials(tokens);
  const api = calendar({ version: "v3", auth: oauth });
  const cal = await findOrCreateCalendar(api, config.googleCalendarId);
  return { refreshToken: tokens.refresh_token, calendarId: cal.id };
}
