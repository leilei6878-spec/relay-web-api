import type { Account, Platform, Proxy } from "./types";
import { singBoxConfig } from "./proxy-link";

export type ParsedSession = {
  cookieCount: number;
};

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
      const hostHit = cookies.some((c) =>
        /leonardo|amazoncognito|cognito-idp/i.test(`${c.domain || ""} ${c.name || ""}`),
      );
      const authHit = cookies.some((c) =>
        /session|auth|token|cognito|idToken|accessToken|__Host-|__Secure-|sid/i.test(c.name || ""),
      );
      const landingOnly = cookies.every((c) =>
        /anonymous-id|_landing_|__cf_bm|cf_clearance/i.test(c.name || ""),
      );
      if (!hostHit) return { ok: false as const, reason: "缺少 Leonardo 登录 Cookie" };
      if (landingOnly || (!authHit && cookies.length < 6)) {
        return { ok: false as const, reason: "Leonardo 登录未完成（仍是游客 Cookie，没有 Session）" };
      }
    }
    const sessionCookies = cookies.filter((c) =>
      /session|SID|PSID|auth|oai-did|cognito|idToken|accessToken/i.test(c.name || ""),
    );
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
READY_SEL = ${JSON.stringify(readySel)}
IDP_HOSTS = [
    "google.com", "googleapis.com", "gstatic.com", "googleusercontent.com",
    "apple.com", "icloud.com",
    "microsoft.com", "microsoftonline.com", "live.com", "office.com",
    "msn.com", "hotmail.com", "outlook.com",
]
CANVA_COM = "https://www.canva.com/?disable-cn-redirect=true"

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
        state = context.storage_state()
    except Exception as e:
        print("读取登录态失败", e)
        return False
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
    try:
        return [c.get("name") or "" for c in context.cookies()]
    except Exception:
        return []

def leonardo_cookies_ok(context):
    names = cookie_names(context)
    if not names:
        return False
    landing_only = all(re.search(r"anonymous-id|_landing_|__cf_bm|cf_clearance", n, re.I) for n in names)
    auth = any(re.search(r"session|auth|token|cognito|idToken|accessToken|__Host-|__Secure-|sid", n, re.I) for n in names)
    if landing_only or (not auth and len(names) < 6):
        return False
    return True

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
    if "/login" in u or "/signup" in u:
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
    return True

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
        if "/auth/login" in url or "/u/login" in url:
            return False
        if sign_in_visible(page):
            return False
        if not leonardo_cookies_ok(context):
            return False
        return "leonardo.ai" in url
    try:
        loc = page.locator(READY_SEL)
        return loc.count() > 0 and loc.first.is_visible()
    except Exception:
        return False

def wait_login(page, context):
    print("在弹出窗口登录", ${email})
    if PLATFORM == "leonardo":
        print("Leonardo 游客首页也有输入框，那不是登录。")
        print("先在 canva.com 国际站登录（不能用 canva.cn，账号不通用）。")
        print("若跳到 .cn，会自动拉回 canva.com/?disable-cn-redirect=true。")
        print("Canva 走绑定节点才能停在 .com；本机中国 IP 会跳到 .cn。")
        print("Canva 登录成功后，会自动打开 Leonardo，再点 Canva 授权。")
        try:
            page.goto(CANVA_COM, wait_until="domcontentloaded", timeout=45000)
        except Exception as e:
            print("打开 canva.com 失败", str(e)[:120])
    else:
        print("看到聊天输入框会自动保存；也可以回到这里按回车。")
    redirected = False
    for _ in range(180):
        try:
            if PLATFORM == "leonardo":
                dismiss_canva_cookies(page)
            if logged_in(page, context):
                if PLATFORM == "leonardo":
                    try:
                        page.goto("https://app.leonardo.ai/generate", wait_until="domcontentloaded", timeout=30000)
                        time.sleep(2)
                    except Exception:
                        pass
                    if not logged_in(page, context):
                        print("打开 /generate 后又回到登录页，登录还没完成。")
                        time.sleep(2)
                        continue
                print("检测到已登录，正在保存…")
                return save_state(context)
            if PLATFORM == "leonardo":
                u = page.url or ""
                if "canva.cn" in u:
                    try:
                        page.goto(to_canva_com(u), wait_until="domcontentloaded", timeout=30000)
                    except Exception:
                        pass
                    time.sleep(1)
                    continue
                if canva_logged_in(page) and "leonardo.ai" not in u:
                    print("Canva 国际站已登录，正在打开 Leonardo…")
                    try:
                        page.goto("https://app.leonardo.ai/generate", wait_until="domcontentloaded", timeout=45000)
                    except Exception:
                        pass
                    time.sleep(2)
                    continue
            if (not redirected) and (page.get_by_text("糟糕，出错了").count() > 0 or page.get_by_text("Route Error").count() > 0):
                redirected = True
                print("ChatGPT 返回了错误页，自动改打开登录地址…")
                try:
                    page.goto("https://chatgpt.com/auth/login", wait_until="domcontentloaded", timeout=30000)
                except Exception:
                    pass
                time.sleep(3)
        except Exception:
            pass
        time.sleep(2)
    print("还没检测到已登录。按回车会再检查一次再保存。")
    try:
        input()
    except Exception:
        pass
    if PLATFORM == "leonardo" and not logged_in(page, context):
        print("当前仍是游客（Sign In 还在，或没有 Session Cookie）。没有写入 state.json。")
        return False
    return save_state(context)

def open_browser(p, proxy):
    args = ["--disable-blink-features=AutomationControlled"]
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

def open_leonardo_chrome(p, proxy):
    server = (proxy or {}).get("server") if isinstance(proxy, dict) else ""
    exe = find_chrome_exe()
    if not exe:
        print("没有本机 Chrome，回退自动化窗口（Canva 更容易拦验证码）")
        browser = open_browser(p, proxy)
        context = open_context(browser)
        page = context.new_page()
        return browser, context, page, False
    user_data = chrome_user_data(exe)
    print("将打开本机 Chrome，和你平时能登录 Canva 的是同一个浏览器。")
    if user_data and chrome_running(user_data):
        print("请完全退出 Chrome（任务栏、右下角托盘都要退），然后按回车。")
        try:
            input()
        except Exception:
            pass
    if user_data and chrome_running(user_data):
        print("Chrome 仍在运行，改用临时配置，验证码仍可能被拦。")
        user_data = os.path.join(HERE, "chrome-profile")
        os.makedirs(user_data, exist_ok=True)
    elif user_data:
        print("使用本机 Chrome 配置文件")
    else:
        user_data = os.path.join(HERE, "chrome-profile")
        os.makedirs(user_data, exist_ok=True)
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
        "--user-data-dir=" + user_data,
        "--remote-debugging-port=%d" % debug,
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        "--disable-quic",
        CANVA_COM,
    ]
    if server:
        args.insert(-1, "--proxy-server=" + server)
    print("正在启动本机 Chrome…")
    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    last_err = ""
    for _ in range(40):
        try:
            browser = p.chromium.connect_over_cdp("http://127.0.0.1:%d" % debug)
            context = browser.contexts[0] if browser.contexts else browser.new_context()
            attach_canva_com_guard(context)
            page = context.pages[0] if context.pages else context.new_page()
            print("已接上本机 Chrome。请在这个窗口登录 canva.com。")
            return browser, context, page, True
        except Exception as e:
            last_err = str(e)[:160]
            time.sleep(0.4)
    print("接不上本机 Chrome：", last_err)
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
    if not cdp:
        browser.close()
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
        if os.path.isfile(p):
            return p
    return shutil.which("sing-box") or shutil.which("sing-box.exe")

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
    bin_path = find_singbox()
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
    if PLATFORM == "leonardo":
        print("Leonardo 登录用绑定节点，不优先用 v2rayN（Canva 会把系统 VPN 当成风险）")
        child = None
        for cfg in CONFIGS:
            child = start_singbox(cfg)
            if child:
                print("已启动包内 sing-box 18080")
                return 18080, "socks5", child
        print("包内节点没起来，再试本机 v2rayN…")
    for port, scheme, label in ((10808, "socks5", "v2rayN SOCKS"), (10809, "http", "v2rayN HTTP")):
        if port_open(port):
            print("使用本机 %s 127.0.0.1:%d（请确认选中平台同一条节点）" % (label, port))
            return port, scheme, None
    if PLATFORM != "leonardo":
        print("未检测到 v2rayN，尝试启动包内节点…")
        child = None
        for cfg in CONFIGS:
            child = start_singbox(cfg)
            if child:
                print("已启动包内 sing-box 18080")
                return 18080, "socks5", child
    print("没有可用本地代理。请先打开 v2rayN，选中 Japan 节点，再运行 run.bat。")
    sys.exit(1)

socks_port, scheme, child = pick_socks()

try:
    with sync_playwright() as p:
        proxy = {"server": "%s://127.0.0.1:%d" % (scheme, socks_port)}
        print("平台节点:", ${node})
        print("正在打开登录页…")
        browser, context, page, cdp = boot(p, proxy, URL)
        wait_login(page, context)
        if not cdp:
            browser.close()
finally:
    if child:
        child.terminate()
`;
}

export function safeName(email: string) {
  return `relay-login-${email.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
}
