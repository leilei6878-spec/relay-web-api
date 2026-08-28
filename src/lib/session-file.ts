import type { Account, Platform, Proxy } from "./types";
import { singBoxConfig } from "./proxy-link";
import { textFile } from "./zip-store";

export type ParsedSession = {
  cookieCount: number;
};

const LEONARDO_AUTH_COOKIE =
  /CognitoIdentityServiceProvider|better-auth\.session(?!_state)|idToken|accessToken|LastAuthUser|session_token|session-token/i;
const LEONARDO_NOISE_COOKIE =
  /oauth_state|csrf-state|xsrf|stripe|intercom|anonymous-id|_landing_|_gcl_|ab\.storage|_hp2_|_cs_|__cuid|^_ga/i;

export function leonardoAuthCookie(name: string, domain = "") {
  const n = name || "";
  if (LEONARDO_NOISE_COOKIE.test(n)) return false;
  if (LEONARDO_AUTH_COOKIE.test(n)) return true;
  return /cognito/i.test(`${domain} ${n}`) && /token|LastAuthUser|idToken|accessToken/i.test(n);
}

export function inspectSession(json: string, platform: Platform) {
  try {
    const parsed = JSON.parse(json) as { cookies?: { name?: string; expires?: number; value?: string; domain?: string }[] };
    const cookies = parsed.cookies || [];
    if (!cookies.length) return { ok: false as const, reason: "Cookie 为空" };
    const now = Date.now() / 1000;
    const names = new Set(cookies.map((c) => c.name || ""));
    const dummy = cookies.length <= 1 && cookies.some((c) => (c.value || "").includes("qa"));
    if (dummy) return { ok: false as const, reason: "演示登录不能商用" };
    if (platform === "chatgpt") {
      const has =
        names.has("__Secure-next-auth.session-token") ||
        names.has("oai-did") ||
        names.has("__Secure-next-auth.session-token.0");
      if (!has) return { ok: false as const, reason: "缺少 ChatGPT 登录 Cookie" };
    }
    if (platform === "leonardo") {
      const authHit = cookies.some((c) => leonardoAuthCookie(c.name || "", c.domain || ""));
      const originHit = Array.isArray((parsed as { origins?: unknown }).origins)
        ? ((parsed as { origins?: { localStorage?: { name?: string }[] }[] }).origins || []).some((o) =>
            (o.localStorage || []).some((row) => leonardoAuthCookie(row.name || "", "")),
          )
        : false;
      if (!authHit && !originHit) {
        const listed = cookies.map((c) => c.name || "").filter(Boolean).slice(0, 12).join("、") || "无";
        const hasCanva = cookies.some((c) => /canva/i.test(`${c.domain || ""} ${c.name || ""}`));
        return {
          ok: false as const,
          reason: hasCanva
            ? `Leonardo 登录未完成：已有 Canva Cookie，但没有 Leonardo Session（${listed}）。请在 Leonardo 点 Continue with Canva，授权弹窗走完，等到 Sign In 消失。`
            : `Leonardo 登录未完成：当前是游客 Cookie（${listed}）。必须先在 Canva 国际站登录，再在 Leonardo 用 Canva 授权；公开出图页不算登录。`,
        };
      }
    }
    const sessionCookies = cookies.filter((c) => {
      const n = c.name || "";
      if (platform === "leonardo") return /better-auth\.session_token/i.test(n);
      return /session|SID|PSID|auth|oai-did|cognito|idToken|accessToken/i.test(n);
    });
    const expiries = sessionCookies
      .map((c) => (typeof c.expires === "number" && c.expires > 0 ? c.expires : 0))
      .filter((n) => n > now);
    const expiresAt = expiries.length ? Math.min(...expiries) : 0;
    const stale = sessionCookies.filter(
      (c) => typeof c.expires === "number" && c.expires > 0 && c.expires < now,
    );
    if (stale.length) return { ok: false as const, reason: "登录 Cookie 已过期" };
    const hoursLeft = expiresAt ? (expiresAt - now) / 3600 : 0;
    const warning = hoursLeft > 0 && hoursLeft < 48 ? `登录约 ${Math.max(1, Math.round(hoursLeft))} 小时后过期` : undefined;
    return { ok: true as const, cookieCount: cookies.length, warning, expiresAt: expiresAt || undefined };
  } catch {
    return { ok: false as const, reason: "登录文件无法解析" };
  }
}

export function summarizeStorageState(json: string, platform?: Platform) {
  try {
    const parsed = JSON.parse(json) as { cookies?: { name?: string; domain?: string }[] };
    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
    const cookieNames = cookies.map((c) => c.name || "").filter(Boolean);
    const plat = platform || "leonardo";
    const inspected = inspectSession(json, plat);
    const authNames = cookies
      .filter((c) => leonardoAuthCookie(c.name || "", c.domain || ""))
      .map((c) => c.name || "")
      .filter(Boolean);
    return {
      ok: inspected.ok,
      reason: inspected.ok ? undefined : inspected.reason,
      warning: inspected.ok ? inspected.warning : undefined,
      cookieCount: cookieNames.length,
      cookieNames: cookieNames.slice(0, 24),
      authNames,
    };
  } catch {
    return {
      ok: false as const,
      reason: "登录文件无法解析",
      cookieCount: 0,
      cookieNames: [] as string[],
      authNames: [] as string[],
    };
  }
}

export function parseStorageState(
  raw: string,
  platform?: Platform,
): { ok: true; data: ParsedSession } | { ok: false; error: string } {
  const text = raw.trim();
  if (!text) return { ok: false, error: "文件是空的" };
  try {
    const parsed = JSON.parse(text) as { cookies?: unknown; origins?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "不是 storage_state 对象" };
    }
    const cookies = parsed.cookies;
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return { ok: false, error: "缺少 cookies，登录可能还没完成" };
    }
    const looksLeonardo = cookies.some((c) => {
      if (!c || typeof c !== "object") return false;
      const row = c as { name?: string; domain?: string };
      return /leonardo|amazoncognito|cognito/i.test(`${row.domain || ""} ${row.name || ""}`);
    });
    const plat = platform ?? (looksLeonardo ? "leonardo" : undefined);
    if (plat) {
      const inspected = inspectSession(text, plat);
      if (!inspected.ok) return { ok: false, error: inspected.reason };
    }
    return { ok: true, data: { cookieCount: cookies.length } };
  } catch {
    return { ok: false, error: "JSON 无法解析" };
  }
}

export function loginUrl(platform: Platform) {
  if (platform === "gemini") return "https://gemini.google.com/app";
  if (platform === "leonardo") return "https://www.canva.com/?disable-cn-redirect=true";
  return "https://chatgpt.com";
}

export function proxyServer(proxy: {
  type: "http" | "socks5" | "ss";
  host: string;
  port: number;
  localPort?: number;
}) {
  if (proxy.type === "ss") {
    const port = Number(process.env.RELAY_SS_LOCAL_PORT || 18080);
    return `socks5://127.0.0.1:${port}`;
  }
  const scheme = proxy.type === "socks5" ? "socks5" : "http";
  return `${scheme}://${proxy.host}:${proxy.port}`;
}

export function loginHelperScript(account: Account, proxy: Proxy, password: string) {
  const url =
    account.platform === "gemini"
      ? "https://gemini.google.com/app"
      : account.platform === "leonardo"
        ? "https://www.canva.com/?disable-cn-redirect=true"
        : "https://chatgpt.com/auth/login";
  const pw = password || proxy.password || "";
  const email = JSON.stringify(account.email);
  const node = JSON.stringify(`${proxy.name} ${proxy.host}:${proxy.port}`);
  const readySel =
    account.platform === "gemini"
      ? "div.ql-editor, rich-textarea, div[contenteditable='true']"
      : account.platform === "leonardo"
        ? "#home-prompt-textarea, button[aria-label='Generate']"
        : "#prompt-textarea, textarea#prompt-textarea, [data-testid='send-button']";

  const waitSave = `
import re, base64, json, os, shutil, socket, subprocess, time
HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
PLATFORM = ${JSON.stringify(account.platform)}
EMAIL = ${email}
READY_SEL = ${JSON.stringify(readySel)}
IDP_HOSTS = [
    "google.com", "googleapis.com", "gstatic.com", "googleusercontent.com",
    "apple.com", "icloud.com",
    "microsoft.com", "microsoftonline.com", "live.com", "office.com",
    "msn.com", "hotmail.com", "outlook.com",
]
CANVA_COM = "https://www.canva.com/?disable-cn-redirect=true"
LEO_LOGIN = "https://app.leonardo.ai/auth/login?callbackUrl=%2Fgenerate"
LEO_GEN = "https://app.leonardo.ai/generate"

def pac_proxy_line(server):
    s = (server or "").strip()
    if s.startswith("socks5://"):
        rest = s[9:]
        kind = "SOCKS5 "
    elif s.startswith("socks://"):
        rest = s[8:]
        kind = "SOCKS "
    elif s.startswith("http://"):
        rest = s[7:]
        kind = "PROXY "
    elif s.startswith("https://"):
        rest = s[8:]
        kind = "HTTPS "
    else:
        rest = s
        kind = "SOCKS5 "
    if "@" in rest:
        rest = rest.split("@", 1)[1]
    return kind + rest

def write_idp_pac(server):
    line = pac_proxy_line(server)
    out = [
        "function FindProxyForURL(url, host) {",
        "  host = (host || '').toLowerCase();",
        "  if (",
    ]
    last = len(IDP_HOSTS) - 1
    for i, d in enumerate(IDP_HOSTS):
        piece = '    (host === "%s" || dnsDomainIs(host, "%s") || shExpMatch(host, "*.%s"))' % (d, d, d)
        if i < last:
            piece += " ||"
        out.append(piece)
    out.append('  ) return "DIRECT";')
    out.append('  return "%s";' % line)
    out.append("}")
    raw = "\\n".join(out) + "\\n"
    b64 = base64.b64encode(raw.encode("utf-8")).decode("ascii")
    return "data:application/x-ns-proxy-autoconfig;base64," + b64

def save_state(context):
    try:
        b = context.browser
        ctxs = list(b.contexts) if b and b.contexts else [context]
    except Exception:
        ctxs = [context]
    cookies, origins, seen = [], [], set()
    merged = all_cookies(context)
    for c in merged:
        key = (c.get("domain"), c.get("name"), c.get("path") or "/", c.get("partitionKey") or "")
        if key in seen:
            continue
        seen.add(key)
        row = {}
        for k in ("name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite"):
            if c.get(k) is not None:
                row[k] = c.get(k)
        if "name" not in row or "value" not in row:
            continue
        if "path" not in row:
            row["path"] = "/"
        ss = str(row.get("sameSite") or "")
        if ss.lower() in ("strict", "lax", "none"):
            row["sameSite"] = ss[0].upper() + ss[1:].lower()
            if row["sameSite"] == "None":
                row["sameSite"] = "None"
        elif "sameSite" in row:
            del row["sameSite"]
        if row.get("sameSite") == "None":
            row["secure"] = True
        cookies.append(row)
    for ctx in ctxs:
        try:
            st = ctx.storage_state()
        except Exception as e:
            print("读取登录态失败", e)
            continue
        for c in st.get("cookies") or []:
            key = (c.get("domain"), c.get("name"), c.get("path") or "/", c.get("partitionKey") or "")
            if key in seen:
                continue
            seen.add(key)
            cookies.append(c)
        origins.extend(st.get("origins") or [])
    if not cookies:
        print("读到的 Cookie 是空的")
        return False
    state = {"cookies": cookies, "origins": origins}
    if PLATFORM == "leonardo":
        keep = []
        for c in state.get("cookies") or []:
            blob = "%s %s" % (c.get("domain") or "", c.get("name") or "")
            if re.search(r"leonardo|canva|cognito|google|apple|microsoft|amazon", blob, re.I):
                keep.append(c)
        if keep:
            state["cookies"] = keep
        state["origins"] = [
            o for o in (state.get("origins") or [])
            if re.search(r"leonardo|canva", o.get("origin") or "", re.I)
        ]
        if not leonardo_auth_names(state.get("cookies") or []):
            print("拒绝保存：还没有 Leonardo Session Cookie（Canva 登录不够，授权弹窗必须走完）")
            print("当前 Cookie:", ", ".join((c.get("name") or "") for c in (state.get("cookies") or [])[:24]))
            return False
    text = json.dumps(state)
    raw = []
    home = os.path.expanduser("~")
    desktop = os.path.join(os.environ.get("USERPROFILE", home), "Desktop")
    desktop_cn = os.path.join(os.environ.get("USERPROFILE", home), "桌面")
    for path in [
        os.path.join(HERE, "state.json"),
        os.path.join(os.getcwd(), "state.json"),
        os.path.join(desktop, "state.json"),
        os.path.join(desktop_cn, "state.json"),
    ]:
        path = os.path.normpath(path)
        if path in raw:
            continue
        folder = os.path.dirname(path)
        if folder and not os.path.isdir(folder):
            continue
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            raw.append(os.path.abspath(path))
        except Exception as e:
            print("写入失败", path, e)
    if raw:
        print("已生成 state.json：")
        for p in raw:
            print(" ", p)
        return True
    print("state.json 没有写出来，把上面的报错发我")
    return False

def cookie_names(context):
    return [c.get("name") or "" for c in all_cookies(context)]

def all_cookies(context):
    out, seen = [], set()
    ctxs = [context]
    try:
        b = context.browser
        if b and b.contexts:
            ctxs = list(b.contexts)
    except Exception:
        pass
    for ctx in ctxs:
        try:
            for c in ctx.cookies():
                key = (c.get("domain"), c.get("name"), c.get("path") or "/", c.get("partitionKey") or "")
                if key in seen:
                    continue
                seen.add(key)
                out.append(c)
        except Exception:
            pass
        try:
            st = ctx.storage_state()
            for c in st.get("cookies") or []:
                key = (c.get("domain"), c.get("name"), c.get("path") or "/", c.get("partitionKey") or "")
                if key in seen:
                    continue
                seen.add(key)
                out.append(c)
        except Exception:
            pass
    for ctx in ctxs:
        try:
            pages = list(ctx.pages or [])
            page = pages[0] if pages else None
            if not page:
                continue
            cdp = ctx.new_cdp_session(page)
            dumped = cdp.send("Network.getAllCookies") or {}
            for c in dumped.get("cookies") or []:
                key = (c.get("domain"), c.get("name"), c.get("path") or "/", c.get("partitionKey") or "")
                if key in seen:
                    continue
                seen.add(key)
                out.append(c)
        except Exception:
            pass
    return out

def is_noise_cookie(name):
    return bool(re.search(r"oauth_state|csrf-state|xsrf|stripe|intercom|anonymous-id|_landing_|_gcl_|ab\\.storage|_hp2_|_cs_|__cuid|^_ga", name or "", re.I))

def is_leonardo_auth_cookie(name, domain=""):
    n = name or ""
    if is_noise_cookie(n):
        return False
    if re.search(r"CognitoIdentityServiceProvider|better-auth\\.session|idToken|accessToken|LastAuthUser|session_token|session-token", n, re.I):
        return True
    return bool(re.search(r"cognito", "%s %s" % (domain, n), re.I) and re.search(r"token|LastAuthUser", n, re.I))

def leonardo_auth_names(cookies):
    return [c.get("name") or "" for c in cookies if is_leonardo_auth_cookie(c.get("name") or "", c.get("domain") or "")]

def leonardo_cookies_ok(context):
    hits = leonardo_auth_names(all_cookies(context))
    if hits:
        return True
    return False

def to_canva_com(url):
    u = url or ""
    if "canva.cn" in u:
        u = u.replace("canva.cn", "canva.com")
    if "canva.com" in u and "disable-cn-redirect=" not in u:
        u += ("&" if "?" in u else "?") + "disable-cn-redirect=true"
    return u

def canva_logged_in(page):
    u = (page.url or "").lower()
    if "canva.cn" in u or "canva.com" not in u:
        return False
    if any(k in u for k in ("/login", "/signup", "/sign-up", "/oidc", "/_login")):
        return False
    try:
        if page.get_by_text("Finish logging in").count() > 0:
            return False
        if page.get_by_text("We can't send a verification code").count() > 0:
            return False
    except Exception:
        pass
    if sign_in_visible(page):
        return False
    in_app = any(k in u for k in ("/folder", "/design", "/projects", "/home", "/s/", "/org/"))
    if in_app:
        return True
    try:
        return canva_has_session(page.context)
    except Exception:
        return False

def canva_has_session(context):
    n = 0
    for c in all_cookies(context):
        d = (c.get("domain") or "").lower()
        name = c.get("name") or ""
        if "canva.com" not in d:
            continue
        if is_noise_cookie(name):
            continue
        n += 1
        if re.search(r"^(CDI|CII|ASI|CAE|CID|CON)$", name, re.I):
            return True
    return n >= 3

def canva_ready(context):
    if canva_has_session(context):
        for pg in all_pages(context):
            u = (pg.url or "").lower()
            if "canva.com" in u and "canva.cn" not in u and "/login" not in u:
                return True
        return True
    for pg in all_pages(context):
        try:
            if canva_logged_in(pg):
                return True
        except Exception:
            pass
    return False

def attach_canva_com_guard(context):
    def handle_route(route):
        url = route.request.url or ""
        if "canva.cn" not in url:
            route.continue_()
            return
        dest = to_canva_com(url)
        print("拦截 canva.cn，拉回 canva.com")
        try:
            route.fulfill(status=302, headers={"Location": dest, "content-type": "text/plain"}, body="")
        except Exception:
            try:
                route.continue_(url=dest)
            except Exception:
                route.abort()

    try:
        context.route("**://canva.cn/**", handle_route)
        context.route("**://*.canva.cn/**", handle_route)
    except Exception:
        pass

    def on_page(page):
        last = [0]
        def pin():
            try:
                now = time.time()
                if now - last[0] < 1.5:
                    return
                u = page.url or ""
                if "canva.cn" in u:
                    last[0] = now
                    print("地址栏跳到了 canva.cn，正在打开 canva.com")
                    page.goto(to_canva_com(u), wait_until="domcontentloaded", timeout=30000)
            except Exception:
                pass
        page.on("framenavigated", lambda f: pin() if f == page.main_frame else None)
        page.on("load", lambda: pin())
    context.on("page", on_page)

def sign_in_visible(page):
    for label in ("Sign In", "Log in", "Log In", "Sign Up"):
        for role in ("link", "button"):
            try:
                loc = page.get_by_role(role, name=label)
                if loc.count() > 0 and loc.first.is_visible():
                    return True
            except Exception:
                pass
    return False

def dismiss_canva_cookies(page):
    for label in ("Accept all cookies", "Accept all", "Allow all"):
        try:
            btn = page.get_by_role("button", name=label)
            if btn.count() > 0 and btn.first.is_visible():
                btn.first.click(timeout=1500)
                print("已接受 Cookie")
                return True
        except Exception:
            pass
    return False

def logged_in(page, context):
    url = page.url or ""
    if PLATFORM == "leonardo":
        if "leonardo.ai" not in url:
            return False
        if "/auth/login" in url or "/u/login" in url:
            return False
        if sign_in_visible(page):
            return False
        if not leonardo_cookies_ok(context):
            return False
        return True
    try:
        loc = page.locator(READY_SEL)
        return loc.count() > 0 and loc.first.is_visible()
    except Exception:
        return False

def all_pages(context):
    out = []
    ctxs = [context]
    try:
        browser = context.browser
        if browser and browser.contexts:
            ctxs = list(browser.contexts)
    except Exception:
        pass
    for ctx in ctxs:
        try:
            out.extend(ctx.pages)
        except Exception:
            pass
    return out

def oauth_busy(pages):
    for p in pages:
        u = (p.url or "").lower()
        if "/generate" in u and "callback" not in u and "oauth" not in u and "authorize" not in u:
            pass
        elif any(k in u for k in (
            "auth.leonardo.ai", "amazoncognito", "cognito-idp",
            "/oauth", "oauth2", "/callback", "/authorize", "client_id=",
            "/brand/oauth", "/oidc",
        )):
            return True
        try:
            if p.get_by_text("Finish logging in").count() > 0:
                return True
            if p.get_by_text("wants to access").count() > 0:
                return True
            if p.get_by_text("Allow Leonardo").count() > 0:
                return True
        except Exception:
            pass
    return False

def canva_sso_labels():
    return [
        "Continue with Canva",
        "Log in with Canva",
        "Sign in with Canva",
        "Sign in with canva",
        "Continue with canva",
        "Canva",
    ]

def list_sso_buttons(page):
    found = []
    for label in canva_sso_labels() + ["Microsoft", "Google", "Apple", "Continue with Email"]:
        for role in ("button", "link"):
            try:
                loc = page.get_by_role(role, name=label)
                if loc.count() > 0 and loc.first.is_visible():
                    found.append(label)
                    break
            except Exception:
                pass
    return found

def click_canva_sso(page):
    u = (page.url or "").lower()
    if "leonardo.ai" not in u:
        return False
    for label in canva_sso_labels():
        for role in ("button", "link"):
            try:
                loc = page.get_by_role(role, name=label, exact=(label == "Canva"))
                if loc.count() == 0 or not loc.first.is_visible():
                    continue
                try:
                    with page.context.expect_popup(timeout=8000):
                        loc.first.click(timeout=2500)
                    print("已弹出 Canva 授权窗口，请在弹窗里点允许，不要关掉")
                    return True
                except Exception:
                    loc.first.click(timeout=2500)
                    print("已点击 Canva 授权，请完成授权，不要关弹窗")
                    return True
            except Exception:
                pass
    try:
        hit = page.evaluate("""() => {
          const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const el = nodes.find((n) => /continue with canva|log in with canva|sign in with canva/i.test((n.innerText || n.getAttribute('aria-label') || '').trim()));
          if (!el) return '';
          el.click();
          return (el.innerText || '').trim().slice(0, 40);
        }""")
        if hit:
            print("已用页面按钮点 Canva 授权:", hit)
            return True
    except Exception:
        pass
    return False

def click_idp_sso(page):
    return click_canva_sso(page)

def leonardo_ready(context):
    pages = all_pages(context)
    for pg in pages:
        try:
            if logged_in(pg, pg.context):
                return pg
        except Exception:
            if logged_in(pg, context):
                return pg
    return None

def wait_login(page, context):
    print("在弹出窗口登录", ${email})
    if PLATFORM == "leonardo":
        print("必须用 Canva 授权 Leonardo，不要点 Microsoft / Google。")
        print("会同时打开 Canva 和 Leonardo 两个标签。")
        print("阶段：1) Canva 国际站登录  2) Leonardo 点 Continue with Canva  3) 授权弹窗走完  4) Sign In 消失才保存")
        print("公开出图页也有 Generate，那不是登录。只登录 Canva、不点授权也不会保存。")
        ensure_canva_and_leonardo_tabs(context, page)
    else:
        print("看到聊天输入框会自动保存；也可以回到这里按回车。")
    redirected = False
    reloaded_once = False
    last_hint = 0
    phase = "canva"
    for i in range(240):
        try:
            pages = all_pages(context)
            ready = leonardo_ready(context) if PLATFORM == "leonardo" else None
            if PLATFORM == "leonardo" and ready:
                print("检测到 Leonardo Session Cookie，正在保存…")
                time.sleep(1.2)
                ready2 = leonardo_ready(context) or ready
                return save_state(ready2.context)
            if PLATFORM != "leonardo":
                if logged_in(page, context):
                    print("检测到已登录，正在保存…")
                    return save_state(context)
                if (not redirected) and (page.get_by_text("糟糕，出错了").count() > 0 or page.get_by_text("Route Error").count() > 0):
                    redirected = True
                    print("ChatGPT 返回了错误页，自动改打开登录地址…")
                    try:
                        page.goto("https://chatgpt.com/auth/login", wait_until="domcontentloaded", timeout=30000)
                    except Exception:
                        pass
                    time.sleep(3)
                time.sleep(2)
                continue
            pages = all_pages(context)
            if oauth_busy(pages):
                phase = "oauth"
                if time.time() - last_hint > 8:
                    print("正在等 Canva 授权弹窗完成，请点允许，不要关弹窗…")
                    last_hint = time.time()
                time.sleep(2)
                continue
            for pg in pages:
                u = pg.url or ""
                if "canva.cn" in u:
                    try:
                        pg.goto(to_canva_com(u), wait_until="domcontentloaded", timeout=30000)
                    except Exception:
                        pass
            if leonardo_cookies_ok(context) and not reloaded_once:
                for pg in pages:
                    if "leonardo.ai" in (pg.url or "") and "/auth/" not in (pg.url or ""):
                        break
                    if "leonardo.ai" in (pg.url or ""):
                        print("已有 Leonardo Session，正在进入 Image Generator…")
                        try:
                            pg.goto(LEO_GEN, wait_until="domcontentloaded", timeout=30000)
                        except Exception:
                            pass
                        reloaded_once = True
                        break
                time.sleep(2)
                continue
            if not canva_ready(context):
                phase = "canva"
                if time.time() - last_hint > 8:
                    print("请先在 Canva 标签登录 canva.com 国际站（不要用 canva.cn）。登好后再回到 Leonardo。")
                    last_hint = time.time()
                time.sleep(2)
                continue
            phase = "sso"
            leo_login = None
            for pg in pages:
                u = pg.url or ""
                if "leonardo.ai" not in u:
                    continue
                if "/auth/login" in u or sign_in_visible(pg):
                    leo_login = pg
                    break
            if leo_login is not None:
                if time.time() - last_hint > 8:
                    found = list_sso_buttons(leo_login)
                    if found:
                        print("Leonardo 登录页按钮:", ", ".join(found))
                    print("Canva 已登录。请手动切到 Leonardo 标签并点 Continue with Canva；助手不会自动点击或抢焦点。")
                    last_hint = time.time()
                phase = "sso-manual"
            elif time.time() - last_hint > 8:
                print("Leonardo 标签可能正在完成 Canva 授权或已被关闭。助手不会重复建页；若没有授权页，请手动新建标签打开:", LEO_LOGIN)
                last_hint = time.time()
            if i % 8 == 0:
                hits = leonardo_auth_names(all_cookies(context))
                names = [c.get("name") or "" for c in all_cookies(context)][:18]
                print("阶段 %s | Canva %s" % (phase, "已登录" if canva_ready(context) else "未登录"))
                print("仍在等 Leonardo Session。当前授权 Cookie:", hits or "无")
                print("当前全部 Cookie:", ", ".join(names) or "无")
        except Exception:
            pass
        time.sleep(2)
    print("还没检测到 Leonardo 已登录。按回车会再检查一次再保存。")
    try:
        input()
    except Exception:
        pass
    ready = leonardo_ready(context) if PLATFORM == "leonardo" else None
    if PLATFORM == "leonardo":
        if ready:
            return save_state(ready.context)
        print("当前仍是游客（没有 Leonardo Session Cookie）。没有写入 state.json。")
        names = [c.get("name") or "" for c in all_cookies(context)][:24]
        print("当前 Cookie:", ", ".join(names) or "无")
        print("必须用 Canva 授权：Canva 国际站登录后，在 Leonardo 点 Continue with Canva，等到 Sign In 消失。")
        return False
    if logged_in(page, context):
        return save_state(context)
    return save_state(context)

def ensure_canva_and_leonardo_tabs(context, page):
    pages = all_pages(context)
    has_canva = any("canva.com" in (pg.url or "") for pg in pages)
    has_leo = any("leonardo.ai" in (pg.url or "") for pg in pages)
    if not has_canva:
        try:
            target = None
            for pg in pages:
                u = (pg.url or "").lower()
                if (not u) or u == "about:blank" or "canva.com" in u:
                    target = pg
                    break
            if target is None:
                target = page if page and "leonardo.ai" not in (page.url or "") else context.new_page()
            target.goto(CANVA_COM, wait_until="domcontentloaded", timeout=45000)
            print("已打开 Canva 标签")
        except Exception as e:
            print("打开 canva.com 失败", str(e)[:120])
    if not has_leo:
        try:
            leo_page = context.new_page()
            leo_page.goto(LEO_LOGIN, wait_until="domcontentloaded", timeout=45000)
            print("已打开 Leonardo 标签")
        except Exception as e:
            print("打开 Leonardo 失败", str(e)[:120])

def open_browser(p, proxy):
    args = ["--disable-blink-features=AutomationControlled"]
    if PLATFORM == "leonardo":
        args.extend(["--disable-popup-blocking", "--disable-features=ThirdPartyStoragePartitioning"])
    ignore = ["--enable-automation"]
    kw = {"headless": False, "args": args, "ignore_default_args": ignore}
    if proxy and PLATFORM == "leonardo":
        server = proxy.get("server") if isinstance(proxy, dict) else ""
        if server:
            pac_url = write_idp_pac(server)
            args.append("--disable-quic")
            args.append("--proxy-pac-url=" + pac_url)
            args.append("--host-resolver-rules=MAP canva.cn www.canva.com,MAP www.canva.cn www.canva.com,MAP app.canva.cn app.canva.com")
            print("Google / Microsoft 验证码走本机；Canva 走绑定节点，避免跳到 canva.cn")
            proxy = None
    if proxy:
        kw["proxy"] = proxy
    for channel in ("chrome", "msedge"):
        try:
            b = p.chromium.launch(channel=channel, **kw)
            print("已用本机浏览器:", channel)
            return b
        except Exception:
            print("本机", channel, "不可用，换下一个")
    print("改用内置 Chromium（更容易被拦截）")
    return p.chromium.launch(**kw)

def open_context(browser):
    kw = {
        "locale": "en-US",
        "viewport": {"width": 1365, "height": 900},
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }
    if PLATFORM == "leonardo":
        kw["timezone_id"] = "Asia/Tokyo"
        kw["geolocation"] = {"longitude": 139.6917, "latitude": 35.6895}
        kw["permissions"] = ["geolocation"]
        kw["extra_http_headers"] = {"Accept-Language": "en-US,en;q=0.9"}
    context = browser.new_context(**kw)
    context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    if PLATFORM == "leonardo":
        attach_canva_com_guard(context)
    return context

def find_chrome_exe():
    local = os.environ.get("LOCALAPPDATA") or ""
    pf = os.environ.get("PROGRAMFILES") or "C:/Program Files"
    pf86 = os.environ.get("PROGRAMFILES(X86)") or "C:/Program Files (x86)"
    cands = [
        os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
    ]
    for path in cands:
        if os.path.isfile(path):
            return path
    return shutil.which("chrome") or shutil.which("msedge") or shutil.which("google-chrome")

def chrome_user_data(exe):
    local = os.environ.get("LOCALAPPDATA") or ""
    if exe and "Edge" in exe.replace("\\\\", "/"):
        path = os.path.join(local, "Microsoft", "Edge", "User Data")
    else:
        path = os.path.join(local, "Google", "Chrome", "User Data")
    return path if path and os.path.isdir(path) else ""

def chrome_running(user_data):
    if not user_data:
        return False
    return os.path.exists(os.path.join(user_data, "lockfile")) or os.path.exists(os.path.join(user_data, "SingletonLock"))

def copy_locked(src, dest):
    try:
        if os.path.isdir(src):
            if os.path.isdir(dest):
                shutil.rmtree(dest, ignore_errors=True)
            shutil.copytree(src, dest, dirs_exist_ok=True)
            return True
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copy2(src, dest)
        return True
    except Exception:
        pass
    if os.path.isfile(src):
        try:
            with open(src, "rb") as f:
                data = f.read()
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data)
            return True
        except Exception:
            return False
    return False

def clone_chrome_profile(src_user_data, dest):
    os.makedirs(dest, exist_ok=True)
    src_default = os.path.join(src_user_data, "Default")
    dest_default = os.path.join(dest, "Default")
    os.makedirs(dest_default, exist_ok=True)
    copied = 0
    names = [
        "Cookies", "Cookies-journal", "Login Data", "Login Data-journal",
        "Web Data", "Web Data-journal", "Preferences", "Secure Preferences",
        "Local Storage", "Session Storage", "Network", "IndexedDB",
    ]
    nested = [
        os.path.join("Network", "Cookies"),
        os.path.join("Network", "Cookies-journal"),
        os.path.join("Network", "Network Persistent State"),
    ]
    if os.path.isdir(src_default):
        for name in names:
            s = os.path.join(src_default, name)
            if os.path.exists(s) and copy_locked(s, os.path.join(dest_default, name)):
                copied += 1
        for rel in nested:
            s = os.path.join(src_default, rel)
            if os.path.exists(s):
                time.sleep(0.15)
                if copy_locked(s, os.path.join(dest_default, rel)):
                    copied += 1
    ls = os.path.join(src_user_data, "Local State")
    if os.path.isfile(ls) and copy_locked(ls, os.path.join(dest, "Local State")):
        copied += 1
    print("已从本机 Chrome 复制 %d 项登录数据到专用窗口（日常 Chrome 不用关）" % copied)
    if copied < 3:
        print("复制到的登录数据很少。请在弹出的专用窗口里重新登录 Canva 国际站。")
    return copied

def close_login_browser(browser, cdp):
    print("state.json 已处理完毕，正在关闭专用登录窗口（日常 Chrome 不会关）")
    try:
        browser.close()
    except Exception:
        pass
    if cdp:
        try:
            kill_helper_chrome(os.path.join(HERE, "chrome-login"))
        except Exception:
            pass

def kill_helper_chrome(user_data):
    marker = os.path.basename(user_data or "")
    if not marker:
        return
    ps = "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*" + marker + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    try:
        subprocess.call(["powershell", "-NoProfile", "-Command", ps], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass

def open_leonardo_chrome(p, proxy):
    server = (proxy or {}).get("server") if isinstance(proxy, dict) else ""
    exe = find_chrome_exe()
    if not exe:
        print("没有本机 Chrome，回退自动化窗口（Canva 更容易拦验证码）")
        browser = open_browser(p, proxy)
        context = open_context(browser)
        page = context.new_page()
        return browser, context, page, False
    live_data = chrome_user_data(exe)
    dest = os.path.join(HERE, "chrome-login")
    print("只会打开一个专用 Chrome 窗口。请只在这个窗口登录，不要用日常浏览器。")
    kill_helper_chrome(dest)
    time.sleep(0.4)
    if live_data:
        clone_chrome_profile(live_data, dest)
    else:
        os.makedirs(dest, exist_ok=True)
    debug = 0
    for port in range(9222, 9240):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", port))
            debug = port
            break
        except OSError:
            pass
        finally:
            s.close()
    if not debug:
        debug = 9222
    args = [
        exe,
        "--user-data-dir=" + dest,
        "--profile-directory=Default",
        "--remote-debugging-port=%d" % debug,
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
        "--disable-features=ThirdPartyStoragePartitioning",
        "--disable-sync",
        "--disable-quic",
    ]
    if server:
        pac_url = write_idp_pac(server)
        args.append("--proxy-pac-url=" + pac_url)
        args.append("--host-resolver-rules=MAP canva.cn www.canva.com,MAP www.canva.cn www.canva.com,MAP app.canva.cn app.canva.com")
        print("验证码走本机网络；Canva / Leonardo 走绑定节点")
    print("正在启动专用 Chrome…")
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    last_err = ""
    for _ in range(50):
        try:
            browser = p.chromium.connect_over_cdp("http://127.0.0.1:%d" % debug)
            context = browser.contexts[0] if browser.contexts else browser.new_context()
            attach_canva_com_guard(context)
            page = context.pages[0] if context.pages else context.new_page()
            print("已接上专用 Chrome。将只在启动阶段各打开一次 Canva 和 Leonardo。")
            return browser, context, page, True
        except Exception as e:
            last_err = str(e)[:160]
            time.sleep(0.4)
    print("接不上专用 Chrome：", last_err)
    print("请关掉刚才弹出的空白窗口后重试。不会再打开空的自动化浏览器。")
    browser = open_browser(p, proxy)
    context = open_context(browser)
    page = context.new_page()
    return browser, context, page, False

def boot(p, proxy, url):
    if PLATFORM == "leonardo":
        return open_leonardo_chrome(p, proxy)
    browser = open_browser(p, proxy)
    context = open_context(browser)
    page = context.new_page()
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
    except Exception as e:
        print("打开失败", str(e)[:120])
    return browser, context, page, False
`;

  if (proxy.type !== "ss") {
    const proxyCfg: Record<string, string> = { server: proxyServer(proxy) };
    if (proxy.username) proxyCfg.username = proxy.username;
    if (pw) proxyCfg.password = pw;
    return `#!/usr/bin/env python3
import os, time
from playwright.sync_api import sync_playwright
${waitSave}
URL = ${JSON.stringify(url)}
PROXY = ${JSON.stringify(proxyCfg, null, 4)}

with sync_playwright() as p:
    print("平台节点:", ${node})
    browser, context, page, cdp = boot(p, PROXY, URL)
    wait_login(page, context)
    close_login_browser(browser, cdp)
`;
  }

  const cfg256 = singBoxConfig({
    ...proxy,
    password: pw,
    method: "2022-blake3-aes-256-gcm",
    localPort: 18080,
  });
  const cfg128 = singBoxConfig({
    ...proxy,
    password: pw,
    method: "2022-blake3-aes-128-gcm",
    localPort: 18080,
  });

  return `#!/usr/bin/env python3
import json, os, shutil, socket, subprocess, sys, time, tempfile
from playwright.sync_api import sync_playwright
${waitSave}
URL = ${JSON.stringify(url)}
CONFIGS = [${JSON.stringify(cfg256)}, ${JSON.stringify(cfg128)}]

def find_singbox():
    for n in ("sing-box.exe", "sing-box"):
        p = os.path.join(HERE, n)
        if os.path.isfile(p) and os.path.getsize(p) > 1000000:
            return p
    return shutil.which("sing-box") or shutil.which("sing-box.exe")

def download_singbox():
    dest = os.path.join(HERE, "sing-box.exe")
    if find_singbox():
        return find_singbox()
    url = "https://github.com/SagerNet/sing-box/releases/download/v1.13.19/sing-box-1.13.19-windows-amd64.zip"
    print("本机没有 v2rayN，正在从 GitHub 下载 sing-box（有进度，超时 45 秒）...")
    zip_path = os.path.join(HERE, "sing-box-win.zip")
    try:
        import urllib.request, zipfile
        req = urllib.request.Request(url, headers={"User-Agent": "relay-login"})
        with urllib.request.urlopen(req, timeout=45) as r, open(zip_path, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            n = 0
            last = 0
            while True:
                chunk = r.read(65536)
                if not chunk:
                    break
                f.write(chunk)
                n += len(chunk)
                if n - last >= 1048576:
                    if total:
                        print("已下载 %d / %d MB" % (n // 1048576, max(1, total // 1048576)))
                    else:
                        print("已下载 %d MB" % (n // 1048576))
                    last = n
        with zipfile.ZipFile(zip_path) as z:
            for n in z.namelist():
                if n.replace("\\\\", "/").lower().endswith("sing-box.exe"):
                    with z.open(n) as src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out)
                    break
        try:
            os.remove(zip_path)
        except Exception:
            pass
        if os.path.isfile(dest) and os.path.getsize(dest) > 1000000:
            print("sing-box 已就绪")
            return dest
    except Exception as e:
        print("下载 sing-box 失败", str(e)[:160])
    return None

def port_open(port):
    s = socket.socket()
    s.settimeout(0.4)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()

def start_singbox(cfg):
    bin_path = find_singbox() or download_singbox()
    if not bin_path:
        return None
    cfg_path = os.path.join(tempfile.gettempdir(), "relay-ss-local.json")
    log_path = os.path.join(HERE, "sing-box.log")
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f)
    logf = open(log_path, "w", encoding="utf-8")
    child = subprocess.Popen([bin_path, "run", "-c", cfg_path], stdout=logf, stderr=subprocess.STDOUT)
    for _ in range(50):
        if port_open(18080):
            return child
        if child.poll() is not None:
            break
        time.sleep(0.15)
    child.terminate()
    return None

def open_page(page, url, timeout=20000):
    for i in range(3):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout)
            return True
        except Exception as e:
            print("打开失败(%d/3)" % (i + 1), url, str(e)[:120])
            time.sleep(1)
    return False

def pick_socks():
    for port, scheme, label in ((10808, "socks5", "v2rayN SOCKS"), (10809, "http", "v2rayN HTTP")):
        if port_open(port):
            print("使用本机 %s 127.0.0.1:%d（请确认选中平台同一条 Japan 节点）" % (label, port))
            return port, scheme, None
    print("没检测到 v2rayN，才下载包内节点…")
    child = None
    for cfg in CONFIGS:
        child = start_singbox(cfg)
        if child:
            print("已启动包内 sing-box 18080")
            return 18080, "socks5", child
    print("没有可用本地代理。请先打开 v2rayN，选中 Japan 节点，再运行 run.bat。不必从 GitHub 下 30MB。")
    sys.exit(1)

socks_port, scheme, child = pick_socks()

try:
    with sync_playwright() as p:
        proxy = {"server": "%s://127.0.0.1:%d" % (scheme, socks_port)}
        print("平台节点:", ${node})
        print("正在打开登录页…")
        browser, context, page, cdp = boot(p, proxy, URL)
        wait_login(page, context)
        close_login_browser(browser, cdp)
finally:
    if child:
        child.terminate()
`;
}

export function loginPackBat() {
  return `@echo off
cd /d "%~dp0"
python -m pip install playwright -q
python -m playwright install chromium
python login.py
echo.
if exist "%~dp0state.json" (
  echo state.json is here:
  echo %~dp0state.json
) else (
  echo state.json not in this folder. Check Desktop.
)
pause
`;
}

export function loginPackReadme(platform: Platform) {
  return platform === "leonardo"
    ? "1. Unzip\n2. Keep daily Chrome open\n3. Double-click run.bat — one dedicated window\n4. Log into canva.com (not canva.cn) in that window\n5. On Leonardo click Continue with Canva. Finish the popup. Wait until Sign In disappears.\n6. Drag state.json back. Guest cookies are rejected.\n"
    : "1. Unzip\n2. Double-click run.bat\n3. Login in the window, then press Enter in the terminal\n4. Drag state.json back to Relay\n";
}

export function loginPackTextFiles(account: Account, proxy: Proxy, password: string) {
  return [
    { name: "login.py", data: textFile(loginHelperScript(account, proxy, password)) },
    { name: "run.bat", data: textFile(loginPackBat()) },
    { name: "README.txt", data: textFile(loginPackReadme(account.platform)) },
  ];
}

export function safeName(email: string) {
  return `relay-login-${email.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
}
