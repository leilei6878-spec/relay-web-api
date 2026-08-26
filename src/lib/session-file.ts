import type { Account, Platform, Proxy } from "./types";
import { singBoxConfig } from "./proxy-link";

export type ParsedSession = {
  cookieCount: number;
};

export function parseStorageState(raw: string): { ok: true; data: ParsedSession } | { ok: false; error: string } {
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
    return { ok: true, data: { cookieCount: cookies.length } };
  } catch {
    return { ok: false, error: "JSON 无法解析" };
  }
}

export function loginUrl(platform: Platform) {
  return platform === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com";
}

export function proxyServer(proxy: {
  type: "http" | "socks5" | "ss";
  host: string;
  port: number;
  localPort?: number;
}) {
  if (proxy.type === "ss") {
    const port = Number(process.env.RELAY_SS_LOCAL_PORT || proxy.localPort || 18080);
    return `socks5://127.0.0.1:${port}`;
  }
  const scheme = proxy.type === "socks5" ? "socks5" : "http";
  return `${scheme}://${proxy.host}:${proxy.port}`;
}

export function loginHelperScript(account: Account, proxy: Proxy, password: string) {
  const url =
    account.platform === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com/auth/login";
  const pw = password || proxy.password || "";
  const email = JSON.stringify(account.email);
  const node = JSON.stringify(`${proxy.name} ${proxy.host}:${proxy.port}`);
  const readySel =
    account.platform === "gemini"
      ? "div.ql-editor, rich-textarea, div[contenteditable='true']"
      : "#prompt-textarea, textarea#prompt-textarea, [data-testid='send-button']";

  const waitSave = `
HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()

def save_state(context):
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
            context.storage_state(path=path)
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

def wait_login(page, context):
    print("在弹出窗口登录", ${email})
    print("看到聊天输入框会自动保存；也可以回到这里按回车。")
    redirected = False
    for _ in range(180):
        try:
            loc = page.locator(${JSON.stringify(readySel)})
            if loc.count() > 0 and loc.first.is_visible():
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
        except Exception:
            pass
        time.sleep(2)
    print("还没检测到输入框。按回车也会保存当前登录态。")
    try:
        input()
    except Exception:
        pass
    return save_state(context)

def open_browser(p, proxy):
    args = ["--disable-blink-features=AutomationControlled"]
    ignore = ["--enable-automation"]
    kw = {"headless": False, "args": args, "ignore_default_args": ignore}
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
    context = browser.new_context(
        locale="en-US",
        viewport={"width": 1365, "height": 900},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    )
    context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    return context
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
    browser = open_browser(p, PROXY)
    context = open_context(browser)
    page = context.new_page()
    print("平台节点:", ${node})
    page.goto(URL, wait_until="domcontentloaded", timeout=45000)
    print("若出现「糟糕，出错了」，点重试，或在地址栏打开 https://chatgpt.com/auth/login")
    wait_login(page, context)
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
    # v2rayN 已通则优先用它，不要先占一个坏的 18080
    for port, scheme, label in ((10808, "socks5", "v2rayN SOCKS"), (10809, "http", "v2rayN HTTP")):
        if port_open(port):
            print("使用本机 %s 127.0.0.1:%d（请确认选中平台同一条节点）" % (label, port))
            return port, scheme, None
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
        browser = open_browser(p, {"server": "%s://127.0.0.1:%d" % (scheme, socks_port)})
        context = open_context(browser)
        page = context.new_page()
        print("平台节点:", ${node})
        print("正在打开登录页…")
        if not open_page(page, URL, 45000):
            print("登录页打不开。请确认 v2rayN 已开、选中同一条日本节点。")
            try:
                input()
            except Exception:
                pass
            sys.exit(1)
        print("若出现「糟糕，出错了」，点重试即可。登录成功会自动保存。")
        wait_login(page, context)
        browser.close()
finally:
    if child:
        child.terminate()
`;
}

export function safeName(email: string) {
  return `relay-login-${email.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
}
