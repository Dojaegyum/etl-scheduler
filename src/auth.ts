import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { calendar } from "@googleapis/calendar";
import { GOOGLE_SCOPE, type Config } from "./config.ts";
import { createOAuthClient, findOrCreateCalendar } from "./google.ts";
import { errorMessage } from "./retry.ts";

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

async function obtainRefreshToken(
  config: Pick<Config, "googleClientId" | "googleClientSecret">,
  opts: { log: (line: string) => void; openBrowser?: (url: string) => void },
): Promise<string> {
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
  return tokens.refresh_token;
}

export type AuthResult = { refreshToken: string; calendarId: string | null; calendarError: string | null };

/**
 * 토큰이 이미 있으면 브라우저 동의를 건너뛰고 캘린더 생성만 한다.
 * 캘린더 생성이 실패해도 토큰은 돌려주어, 동의를 다시 받지 않고 재시도할 수 있게 한다.
 */
export async function runAuth(
  config: Pick<Config, "googleClientId" | "googleClientSecret" | "googleRefreshToken" | "googleCalendarId">,
  opts: { log: (line: string) => void; openBrowser?: (url: string) => void },
): Promise<AuthResult> {
  let refreshToken = config.googleRefreshToken;
  if (refreshToken) {
    opts.log("GOOGLE_REFRESH_TOKEN이 이미 있어 브라우저 동의를 건너뛰고 캘린더만 확인합니다.");
  } else {
    refreshToken = await obtainRefreshToken(config, opts);
  }

  const oauth = createOAuthClient(config.googleClientId, config.googleClientSecret);
  oauth.setCredentials({ refresh_token: refreshToken });
  const api = calendar({ version: "v3", auth: oauth });
  try {
    const cal = await findOrCreateCalendar(api, config.googleCalendarId);
    return { refreshToken, calendarId: cal.id, calendarError: null };
  } catch (err) {
    return { refreshToken, calendarId: null, calendarError: errorMessage(err) };
  }
}
