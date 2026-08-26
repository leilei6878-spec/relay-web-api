export const LOCAL_WORKER = "http://127.0.0.1:18765";

export function localWorkerScript() {
  return `#!/usr/bin/env python3
# Relay 本机 ChatGPT Worker。保持窗口开着，平台试运行会连过来。
import json, os, socket, ssl, subprocess, sys, tempfile, threading, time, base64
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("RELAY_WORKER_PORT") or "18765")
STATE = os.path.join(HERE, "state.json")
HEADLESS = os.environ.get("RELAY_HEADLESS") == "1"
TEST_URL = os.environ.get("RELAY_TEST_URL") or ""
CHAT_URL = os.environ.get("RELAY_CHAT_URL") or TEST_URL or "https://chatgpt.com/"
DRAINING = False
ACTIVE = 0
BROWSERS = 0
ACCOUNT_LOCKS = {}
CAPACITY = int(os.environ.get("RELAY_CAPACITY") or os.environ.get("RELAY_CONCURRENCY") or "3")
SEM = threading.Semaphore(max(1, CAPACITY))
MOCK_HTML = """<!doctype html><meta charset="utf-8"><title>mock</title>
<textarea id="prompt-textarea"></textarea>
<button data-testid="send-button">Send</button>
<div id="thread"></div>
<script>
document.querySelector("[data-testid=send-button]").addEventListener("click", function() {
  var t = document.querySelector("#prompt-textarea").value;
  var d = document.createElement("div");
  d.setAttribute("data-message-author-role", "assistant");
  d.textContent = "MOCK:" + t;
  document.getElementById("thread").appendChild(d);
});
</script>
"""

def port_open(port):
    s = socket.socket()
    s.settimeout(0.3)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()

def pick_proxy():
    for port, scheme in ((18080, "socks5"), (10808, "socks5"), (10809, "http")):
        if port_open(port):
            return {"server": "%s://127.0.0.1:%d" % (scheme, port)}
    return None

def socks_https_ok(proxy):
    server = ""
    if isinstance(proxy, dict):
        server = proxy.get("server") or ""
    if not server.startswith("socks5"):
        return True
    try:
        hostport = server.split("://", 1)[-1]
        sh, sp = hostport.rsplit(":", 1)
        sh = sh.strip("[]")
        dest = "api.ipify.org"
        s = socket.socket()
        s.settimeout(6)
        s.connect((sh, int(sp)))
        s.send(b"\\x05\\x01\\x00")
        greet = s.recv(2)
        if not greet:
            s.close()
            return False
        req = b"\\x05\\x01\\x00\\x03" + bytes([len(dest)]) + dest.encode() + (443).to_bytes(2, "big")
        s.send(req)
        resp = s.recv(16)
        if not resp or len(resp) < 2 or resp[1] != 0:
            s.close()
            return False
        ctx = ssl.create_default_context()
        tls = ctx.wrap_socket(s, server_hostname=dest)
        tls.send(b"GET / HTTP/1.1\\r\\nHost: api.ipify.org\\r\\nConnection: close\\r\\n\\r\\n")
        body = tls.recv(256)
        tls.close()
        return b"." in body or b":" in body
    except Exception:
        return False

def tunnel_down_error():
    return (
        "PROXY_TUNNEL_DOWN: Shadowsocks 隧道无法出网（本机 SOCKS 在听，但 HTTPS 被断开）。"
        "云端执行器连不上这个节点。请在已开启 v2rayN 的电脑上，打开总览页下载并运行「本机 Worker」。"
    )

def job_proxy(body):
    p = body.get("proxy") or {}
    if isinstance(p, dict) and p.get("server"):
        kw = {"server": p.get("server")}
        if p.get("username"):
            kw["username"] = p.get("username")
            kw["password"] = p.get("password") or ""
        return kw
    if os.environ.get("RELAY_ALLOW_MOCK") == "1":
        return pick_proxy()
    return None

def account_lock(aid):
    ACCOUNT_LOCKS.setdefault(aid or "_", threading.Lock())
    return ACCOUNT_LOCKS[aid or "_"]

def post_chunk(text, phase=""):
    gw = (os.environ.get("RELAY_GATEWAY") or "").rstrip("/")
    token = os.environ.get("RELAY_TOKEN") or ""
    jid = os.environ.get("RELAY_JOB_ID") or ""
    if not (gw and token and jid and (text or phase)):
        return
    try:
        import urllib.request
        payload = {
            "id": jid,
            "leaseId": os.environ.get("RELAY_LEASE_ID") or "",
            "fencingToken": int(os.environ.get("RELAY_FENCE") or "0") or None,
            "attemptId": os.environ.get("RELAY_ATTEMPT_ID") or "",
        }
        if text:
            payload["text"] = text
        if phase:
            payload["phase"] = phase
        req = urllib.request.Request(
            gw + "/api/worker/chunk",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=8).read()
    except Exception:
        pass

def post_phase(phase):
    post_chunk("", phase)

def exit_ip(context):
    try:
        r = context.request.get("https://api.ipify.org", timeout=8000)
        return (r.text() or "").strip()
    except Exception:
        try:
            r = context.request.get("https://ifconfig.me/ip", timeout=8000)
            return (r.text() or "").strip()
        except Exception:
            return ""

def extract_prompt_images(body):
    images = []
    def add(u):
        if isinstance(u, str) and u:
            images.append(u)
        elif isinstance(u, dict):
            add(u.get("url") or (u.get("image_url") or {}).get("url") if isinstance(u.get("image_url"), dict) else u.get("image_url"))
    for u in body.get("images") or []:
        add(u)
    add(body.get("image") or body.get("image_url"))
    prompt = (body.get("prompt") or "").strip()
    msgs = body.get("messages") or []
    if msgs:
        last = msgs[-1] if isinstance(msgs[-1], dict) else {}
        content = last.get("content")
        if isinstance(content, str):
            prompt = content.strip() or prompt
        elif isinstance(content, list):
            texts = []
            for part in content:
                if isinstance(part, str):
                    texts.append(part)
                elif isinstance(part, dict):
                    if part.get("type") == "text" or part.get("text"):
                        texts.append(part.get("text") or "")
                    else:
                        add(part.get("image_url") or part.get("image") or part)
            prompt = "\\n".join([t for t in texts if t]).strip() or prompt
    return prompt, images[:4]

def materialize_images(images):
    paths = []
    for i, item in enumerate(images or []):
        url = item if isinstance(item, str) else (item.get("url") if isinstance(item, dict) else "")
        if not url:
            continue
        try:
            if url.startswith("data:"):
                header, b64 = url.split(",", 1)
                ext = "png"
                if "jpeg" in header or "jpg" in header:
                    ext = "jpg"
                elif "webp" in header:
                    ext = "webp"
                path = os.path.join(tempfile.gettempdir(), "relay-img-%s-%d.%s" % (os.getpid(), i, ext))
                with open(path, "wb") as f:
                    f.write(base64.b64decode(b64))
                paths.append(path)
        except Exception:
            continue
    return paths

def attach_images(page, images):
    paths = materialize_images(images)
    if not paths:
        return
    try:
        loc = page.locator("input[type=file]")
        if loc.count() > 0:
            loc.first.set_input_files(paths)
            time.sleep(0.7)
            return
    except Exception:
        pass
    try:
        with page.expect_file_chooser(timeout=5000) as fc:
            for sel in (
                'button[aria-label*="Attach"]',
                'button[aria-label*="上传"]',
                'button[aria-label*="Add photos"]',
                'button[data-testid="composer-plus-btn"]',
                'button[aria-label*="Add files"]',
            ):
                btn = page.locator(sel).first
                try:
                    if btn.count() > 0 and btn.is_visible():
                        btn.click()
                        break
                except Exception:
                    continue
        fc.value.set_files(paths)
        time.sleep(0.7)
    except Exception:
        try:
            page.locator("input[type=file]").first.set_input_files(paths)
        except Exception:
            pass


def detect_page_state(page, provider="chatgpt"):
    url = ""
    html = ""
    try:
        url = page.url or ""
    except Exception:
        url = ""
    try:
        html = (page.content() or "")[:12000].lower()
    except Exception:
        html = ""
    if "captcha" in html or "cf-challenge" in html or "verify you are" in html or "turnstile" in html or "unusual traffic" in html:
        return "CHALLENGE"
    if "deactivated" in html or "suspended" in html or "account has been disabled" in html or "restricted" in html:
        return "ACCOUNT_RESTRICTED"
    if "too many requests" in html or "rate limit" in html or "try again later" in html or "usage limit" in html:
        return "RATE_LIMITED"
    if "accounts.google.com" in url or "/auth/login" in url or "/login" in url or "sign in to chatgpt" in html or "continue with google" in html:
        return "LOGIN_REQUIRED"
    stop = False
    composer = False
    send = False
    assistant = False
    try:
        stop = page.locator("button[data-testid='stop-button'], button[aria-label*='Stop']").first.is_visible()
    except Exception:
        stop = False
    try:
        if provider == "gemini":
            composer = page.locator("div.ql-editor, rich-textarea, div[contenteditable='true']").first.count() > 0
            send = page.locator("button[aria-label*='Send'], button[aria-label*='发送']").first.count() > 0
        else:
            composer = page.locator("#prompt-textarea, textarea#prompt-textarea, div[contenteditable='true']#prompt-textarea").first.count() > 0
            send = page.locator("button[data-testid='send-button'], button[aria-label='Send prompt']").first.count() > 0
            assistant = page.locator("div[data-message-author-role='assistant']").first.count() > 0
    except Exception:
        pass
    if stop:
        return "GENERATING"
    if assistant and not stop:
        return "RESULT_READY"
    if composer:
        return "COMPOSER_READY"
    if "chatgpt.com" in url or "gemini.google.com" in url:
        return "AUTHENTICATED"
    return "DOM_UNKNOWN"

def page_state_error(state, selector_failed=False):
    if state == "LOGIN_REQUIRED":
        return "LOGIN_REQUIRED: provider login wall", "account"
    if state == "CHALLENGE":
        return "CHALLENGE: captcha or bot wall", "provider"
    if state == "RATE_LIMITED":
        return "ACCOUNT_RATE_LIMIT: provider throttle", "account"
    if state == "ACCOUNT_RESTRICTED":
        return "ACCOUNT_BANNED: account disabled", "account"
    if state == "PROVIDER_ERROR":
        return "PROVIDER_UNAVAILABLE: provider error page", "provider"
    if selector_failed:
        return "PROVIDER_DOM_CHANGED: selector miss (page_state=%s)" % state, "provider"
    return "PROVIDER_UNAVAILABLE: page_state=%s" % state, "provider"

def page_fingerprint(page, pack):
    feats = []
    for key, sels in (pack or {}).items():
        if not isinstance(sels, list):
            continue
        present = False
        for s in sels[:3]:
            try:
                if page.locator(s).first.count() > 0:
                    present = True
                    break
            except Exception:
                pass
        feats.append("%s:%d" % (key, 1 if present else 0))
    testds = []
    try:
        testds = page.eval_on_selector_all("[data-testid]", "els => els.map(e => e.getAttribute('data-testid')).filter(Boolean).slice(0, 16)") or []
    except Exception:
        testds = []
    return {"features": feats, "testids": testds[:16], "pack": (pack or {}).get("version") or ""}

def pick_locator(page, names, limit=4):
    tried = 0
    for s in names or []:
        if tried >= limit:
            break
        tried += 1
        loc = page.locator(s).first
        try:
            if loc.count() > 0 and loc.is_visible():
                return loc, s
        except Exception:
            pass
    return None, None

def snapshot_image_srcs(page):
    out = []
    try:
        n = page.locator("img").count()
        for i in range(n):
            src = page.locator("img").nth(i).get_attribute("src") or ""
            if src:
                out.append(src)
    except Exception:
        pass
    return out

def accept_result_image(src, baseline, box=None):
    if not src:
        return False
    if src in (baseline or []):
        return False
    low = src.lower()
    for bad in ("favicon", "avatar", "logo", "sprite", "icon", "/static/", "profile"):
        if bad in low:
            return False
    if src.startswith("data:image/svg"):
        return False
    if src.startswith("data:image") and len(src) < 800:
        return False
    if box and (box.get("width", 0) < 64 or box.get("height", 0) < 64):
        return False
    if "googleusercontent" in src or (src.startswith("data:image") and len(src) > 800):
        return True
    return False

def format_turns(turns):
    if not turns:
        return ""
    blocks = []
    last_i = len(turns) - 1
    for i, turn in enumerate(turns):
        if not isinstance(turn, dict):
            continue
        role = str(turn.get("role") or "user").upper()
        text = turn.get("text") or ""
        imgs = turn.get("images") or []
        note = ("\\n[attached:%d image(s)]" % len(imgs)) if imgs else ""
        cur = ' current="true"' if i == last_i else ""
        blocks.append("<relay:%s%s>\\n%s%s\\n</relay:%s>" % (role, cur, text, note, role))
    return "\\n\\n".join(blocks).strip()

PW = None
BROWSER_POOL = {}
CTX_POOL = {}
POOL_LOCK = threading.Lock()
MAX_BROWSERS = int(os.environ.get("RELAY_MAX_BROWSERS") or "4")
MAX_CTX = int(os.environ.get("RELAY_MAX_CTX_PER_BROWSER") or "8")
CTX_IDLE = int(os.environ.get("RELAY_CTX_IDLE") or "180")
CTX_MAX_REQ = int(os.environ.get("RELAY_CTX_MAX_REQ") or "20")

def playwright_inst():
    global PW
    if PW is None:
        from playwright.sync_api import sync_playwright
        PW = sync_playwright().start()
    return PW

def pool_enabled():
    if os.environ.get("RELAY_TEST_URL"):
        return False
    return os.environ.get("RELAY_BROWSER_POOL") == "1"

def recycle_idle_contexts():
    now = time.time()
    dead = []
    for key, row in list(CTX_POOL.items()):
        if now - row.get("last", now) > CTX_IDLE or row.get("n", 0) >= CTX_MAX_REQ:
            dead.append(key)
    for key in dead:
        row = CTX_POOL.pop(key, None)
        try:
            if row and row.get("ctx"):
                row["ctx"].close()
        except Exception:
            pass

def get_pooled_context(proxy, storage_state, account_id):
    p = playwright_inst()
    proxy_key = ((proxy or {}).get("server") if isinstance(proxy, dict) else "") or "direct"
    with POOL_LOCK:
        recycle_idle_contexts()
        browser = BROWSER_POOL.get(proxy_key)
        if browser is None or not getattr(browser, "is_connected", lambda: True)():
            if len(BROWSER_POOL) >= MAX_BROWSERS:
                old_key = next(iter(BROWSER_POOL))
                try:
                    BROWSER_POOL[old_key].close()
                except Exception:
                    pass
                BROWSER_POOL.pop(old_key, None)
                for k in [k for k in CTX_POOL if k.startswith(old_key + "|")]:
                    try:
                        CTX_POOL[k]["ctx"].close()
                    except Exception:
                        pass
                    CTX_POOL.pop(k, None)
            browser = open_browser(p, proxy)
            BROWSER_POOL[proxy_key] = browser
        ctx_key = "%s|%s" % (proxy_key, account_id or "_")
        row = CTX_POOL.get(ctx_key)
        if row and row.get("ctx") and row.get("n", 0) < CTX_MAX_REQ:
            row["last"] = time.time()
            row["n"] = row.get("n", 0) + 1
            return browser, row["ctx"], False
        if row:
            try:
                row["ctx"].close()
            except Exception:
                pass
            CTX_POOL.pop(ctx_key, None)
        same = [k for k in CTX_POOL if k.startswith(proxy_key + "|")]
        if len(same) >= MAX_CTX:
            old = same[0]
            try:
                CTX_POOL[old]["ctx"].close()
            except Exception:
                pass
            CTX_POOL.pop(old, None)
        kw = {
            "storage_state": storage_state if (storage_state and (storage_state.get("cookies") or storage_state.get("origins"))) else None,
            "locale": "en-US",
            "viewport": {"width": 1365, "height": 900},
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        }
        ctx = browser.new_context(**kw)
        try:
            ctx.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        except Exception:
            pass
        CTX_POOL[ctx_key] = {"ctx": ctx, "last": time.time(), "n": 1}
        return browser, ctx, True


def open_browser(p, proxy):
    args = ["--disable-blink-features=AutomationControlled"]
    ignore = ["--enable-automation"]
    kw = {"headless": HEADLESS, "args": args, "ignore_default_args": ignore}
    if HEADLESS:
        kw["args"] = args + ["--no-sandbox", "--disable-dev-shm-usage"]
    if proxy:
        kw["proxy"] = proxy
    if HEADLESS:
        return p.chromium.launch(**kw)
    for channel in ("chrome", "msedge"):
        try:
            return p.chromium.launch(channel=channel, **kw)
        except Exception:
            pass
    return p.chromium.launch(**kw)

def select_model(page, model):
    labels = {
        "gpt-5.6": ["GPT-5.6", "5.6"],
        "latest": ["GPT-5.6", "GPT-5"],
        "gpt-5": ["GPT-5 Auto", "Auto", "GPT-5"],
        "gpt-5-thinking": ["GPT-5 Thinking", "Thinking"],
        "gpt-4o": ["GPT-4o", "4o"],
    }.get(model, [model])
    switchers = [
        '[data-testid="model-switcher-dropdown-button"]',
        'button[aria-haspopup="menu"]',
        'button:has-text("GPT")',
    ]
    switcher = None
    for sw in switchers:
        loc = page.locator(sw).first
        try:
            if loc.count() > 0 and loc.is_visible():
                switcher = loc
                loc.click(timeout=2500)
                time.sleep(0.35)
                break
        except Exception:
            continue
    for lab in labels:
        try:
            opt = page.get_by_text(lab, exact=False).first
            if opt.count() > 0:
                opt.click(timeout=2500)
                time.sleep(0.2)
                break
        except Exception:
            continue
    actual = ""
    if switcher:
        try:
            actual = (switcher.inner_text() or "").strip()
        except Exception:
            actual = ""
    if not actual:
        try:
            actual = (page.locator(switchers[0]).first.inner_text() or "").strip()
        except Exception:
            actual = ""
    ok = any(lab.lower() in actual.lower() for lab in labels) if actual else False
    return ok, actual

def run_chat(body):
    from playwright.sync_api import sync_playwright
    prompt, images = extract_prompt_images(body)
    if body.get("turns"):
        formatted = format_turns(body.get("turns"))
        if formatted:
            prompt = formatted
        for turn in body.get("turns") or []:
            if isinstance(turn, dict):
                for u in turn.get("images") or []:
                    if u and u not in images:
                        images.append(u)
        images = images[:4]
    prompt = (prompt or "").strip()
    if not prompt and images:
        prompt = "请描述这张图片"
    if not prompt:
        return {"ok": False, "error": "没有要发送的内容"}
    state = body.get("storageState")
    if not state and os.path.isfile(STATE):
        with open(STATE, "r", encoding="utf-8") as f:
            state = json.load(f)
    real = False
    try:
        names = {c.get("name") for c in (state or {}).get("cookies") or []}
        real = bool(names & {"oai-did", "__Secure-next-auth.session-token", "oai-h-sc", "__cflb"})
    except Exception:
        real = False
    if TEST_URL and not real:
        return {"ok": True, "text": "MOCK:" + prompt}
    if not state:
        return {"ok": False, "error": "没有登录态。把 state.json 放到本目录，或从平台下发 Session"}
    sel = body.get("selectors") or {}
    inp = (sel.get("input") or ["#prompt-textarea", "textarea#prompt-textarea"])[:4]
    send = (sel.get("send") or ["button[data-testid='send-button']", "button[aria-label='Send prompt']"])[:4]
    assistant = (sel.get("assistant") or ["div[data-message-author-role='assistant']"])[:4]
    stop = (sel.get("streamingStop") or ["button[aria-label='Stop streaming']", "button[data-testid='stop-button']"])[:4]
    pack_version = body.get("selectorPackVersion") or sel.get("version") or "chatgpt-v1"
    timeout_ms = int(body.get("timeoutMs") or 90000)
    model = (body.get("model") or "gpt-5.6").strip()
    proxy = job_proxy(body)
    if not proxy:
        return {"ok": False, "error": "PROXY_UNAVAILABLE: job missing account-bound proxy", "fault": "proxy"}
    if not TEST_URL:
        post_phase("checking_proxy")
        if not socks_https_ok(proxy):
            return {"ok": False, "error": tunnel_down_error(), "fault": "proxy"}

    def first_visible(page, names):
        loc, _sel = pick_locator(page, names, 4)
        return loc

    def run_on(page, context, close_browser):
        t0 = time.time()
        post_phase("opening_chatgpt")
        try:
            page.goto(CHAT_URL if not real else "https://chatgpt.com/", wait_until="domcontentloaded", timeout=25000)
        except Exception as e:
            t = str(e)
            if "ERR_CONNECTION_CLOSED" in t or "ERR_CONNECTION_RESET" in t or "ERR_TUNNEL" in t:
                return {"ok": False, "error": tunnel_down_error(), "fault": "proxy"}
            return {"ok": False, "error": "CHAT_PAGE_TIMEOUT: 打不开 chatgpt.com（%s）" % t[:160], "fault": "proxy"}
        post_phase("page_ready")
        switched, actual = select_model(page, model)
        if not TEST_URL:
            ip = exit_ip(context)
            if not ip:
                return {"ok": False, "error": "PROXY_UNAVAILABLE: exit IP probe failed", "fault": "proxy"}
        if not switched and not TEST_URL:
            code = "MODEL_SELECTION_UNCONFIRMED" if not actual else "MODEL_MISMATCH"
            return {"ok": False, "error": code + ": failed to select " + model, "fault": "provider", "modelActual": actual or ""}
        attach_images(page, images)
        box = first_visible(page, inp)
        if box is None:
            pst = detect_page_state(page, "chatgpt")
            err, fault = page_state_error(pst, True)
            return {"ok": False, "error": err, "fault": fault, "pageState": pst, "selectorPackVersion": pack_version, "fingerprint": page_fingerprint(page, sel)}
        post_phase("composer_ready")
        if body.get("kind") == "canary":
            fp = page_fingerprint(page, sel)
            pst = detect_page_state(page, "chatgpt")
            send_ok = first_visible(page, send) is not None
            return {
                "ok": pst in ("COMPOSER_READY", "AUTHENTICATED", "RESULT_READY", "GENERATING") and send_ok,
                "text": "CANARY",
                "pageState": pst,
                "fingerprint": fp,
                "selectorPackVersion": pack_version,
                "modelActual": actual or model,
                "sessionBaseVersion": int(body.get("sessionVersion") or 0),
                "sessionVersion": int(body.get("sessionVersion") or 0) + 1,
            }
        before = page.locator(",".join(assistant)).count()
        box.click()
        box.fill(prompt)
        btn = first_visible(page, send)
        if btn:
            btn.click()
        else:
            page.keyboard.press("Enter")
        post_phase("generating")
        stop_sel = ",".join(stop)
        stop_wait = 800 if TEST_URL else 12000
        stop_seen = False
        try:
            page.locator(stop_sel).first.wait_for(state="visible", timeout=stop_wait)
            stop_seen = True
        except Exception:
            pass
        if stop_seen:
            try:
                page.locator(stop_sel).first.wait_for(state="hidden", timeout=3000 if TEST_URL else max(3000, timeout_ms))
            except Exception:
                pass
        deadline = time.time() + timeout_ms / 1000
        text = ""
        stable = ""
        same = 0
        while time.time() < deadline:
            nodes = page.locator(",".join(assistant))
            n = nodes.count()
            cur = ""
            if n > before:
                cur = (nodes.nth(n - 1).inner_text() or "").strip()
            if cur:
                if cur == stable:
                    same += 1
                    if same >= (1 if stop_seen else 2):
                        text = cur
                        break
                else:
                    stable = cur
                    same = 0
                    post_chunk(cur)
            time.sleep(0.2 if stop_seen else 0.28)
        if not text:
            text = stable
        if not text:
            pst = detect_page_state(page, "chatgpt")
            return {"ok": False, "error": "TIMEOUT: empty assistant", "fault": "provider", "pageState": pst}
        try:
            state_out = context.storage_state()
        except Exception:
            state_out = None
        observe = int((time.time() - t0) * 1000)
        return {
            "ok": True,
            "text": text,
            "sessionState": state_out,
            "sessionBaseVersion": int(body.get("sessionVersion") or 0),
            "sessionVersion": int(body.get("sessionVersion") or 0) + 1,
            "modelActual": actual or model,
            "selectorPackVersion": pack_version,
            "pageState": "RESULT_READY",
            "latencyMs": observe,
        }

    if pool_enabled():
        browser, context, _fresh = get_pooled_context(proxy, state, body.get("accountId"))
        page = context.new_page()
        try:
            return run_on(page, context, False)
        finally:
            try:
                page.close()
            except Exception:
                pass
    with sync_playwright() as p:
        browser = open_browser(p, proxy)
        context = browser.new_context(
            storage_state=state if (state and (state.get("cookies") or state.get("origins"))) else None,
            locale="en-US",
            viewport={"width": 1365, "height": 900},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        page = context.new_page()
        try:
            return run_on(page, context, True)
        except Exception as e:
            return {"ok": False, "error": "WORKER_CRASH: %s" % str(e)[:240], "fault": "worker"}
        finally:
            browser.close()

class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stdout.write("[%s] %s\\n" % (self.log_date_time_string(), fmt % args))

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/mock"):
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(MOCK_HTML.encode("utf-8"))
            return
        if self.path.startswith("/health") or self.path in ("/", "/healthz"):
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            proxy = bool(pick_proxy())
            self.wfile.write(json.dumps({"ok": True, "proxy": proxy, "mode": "test" if TEST_URL else "live", "draining": DRAINING, "active": ACTIVE}).encode("utf-8"))
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path not in ("/chat", "/image", "/v1/chat/completions", "/v1/images/generations", "/v1/images/edits"):
            self.send_response(404)
            self.end_headers()
            return
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8") if n else "{}"
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        if self.path in ("/image", "/v1/images/generations", "/v1/images/edits"):
            body["platform"] = "gemini"
        try:
            result = exec_job(body)
        except Exception as e:
            result = {"ok": False, "error": str(e)[:400]}
        self.send_response(200 if result.get("ok") else 500)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))

def exec_job(body):
    global ACTIVE
    prompt, images = extract_prompt_images(body)
    body = dict(body)
    body["prompt"] = prompt
    body["images"] = images
    os.environ["RELAY_JOB_ID"] = str(body.get("id") or os.environ.get("RELAY_JOB_ID") or "")
    os.environ["RELAY_LEASE_ID"] = str(body.get("leaseId") or "")
    os.environ["RELAY_ATTEMPT_ID"] = str(body.get("attemptId") or "")
    os.environ["RELAY_FENCE"] = str(body.get("fencingToken") or "0")
    os.environ["RELAY_ACCOUNT_ID"] = str(body.get("accountId") or "")
    aid = str(body.get("accountId") or "")
    SEM.acquire()
    account_lock(aid).acquire()
    ACTIVE += 1
    try:
        if body.get("platform") in ("gemini", "image") or body.get("kind") == "image":
            return run_image(body)
        return run_chat(body)
    except Exception as e:
        return {"ok": False, "error": "WORKER_CRASH: %s" % str(e)[:240], "fault": "worker"}
    finally:
        ACTIVE -= 1
        account_lock(aid).release()
        SEM.release()

def run_image(body):
    prompt, images = extract_prompt_images(body)
    if not prompt and images:
        prompt = "根据参考图生成一张新图"
    if not prompt:
        return {"ok": False, "error": "没有出图说明"}
    state = body.get("storageState")
    real = False
    try:
        names = {c.get("name") for c in (state or {}).get("cookies") or []}
        real = bool(names)
    except Exception:
        real = False
    if os.environ.get("RELAY_ALLOW_MOCK") == "1":
        img = make_image(prompt, images)
        img["mode"] = "mock"
        return img
    if not real:
        return {"ok": False, "error": "SESSION_INVALID: missing gemini cookies", "fault": "account"}
    from playwright.sync_api import sync_playwright
    proxy = job_proxy(body)
    if not proxy:
        return {"ok": False, "error": "PROXY_UNAVAILABLE: job missing account-bound proxy", "fault": "proxy"}
    if not TEST_URL and not socks_https_ok(proxy):
        return {"ok": False, "error": tunnel_down_error(), "fault": "proxy"}
    sel = body.get("selectors") or {}
    inp = (sel.get("input") or ["div.ql-editor", "div[contenteditable='true']", "rich-textarea"])[:4]
    send = (sel.get("send") or ["button[aria-label*='Send']", "button[aria-label*='发送']"])[:4]
    pack_version = body.get("selectorPackVersion") or sel.get("version") or "gemini-v1"

    def run_image_on(page, context):
        page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=45000)
        time.sleep(1.2)
        pst = detect_page_state(page, "gemini")
        if pst in ("LOGIN_REQUIRED", "CHALLENGE", "RATE_LIMITED", "ACCOUNT_RESTRICTED"):
            err, fault = page_state_error(pst, False)
            return {"ok": False, "error": err, "fault": fault, "pageState": pst}
        baseline = snapshot_image_srcs(page)
        attach_images(page, images)
        box, _ = pick_locator(page, inp, 4)
        if box is None:
            pst = detect_page_state(page, "gemini")
            err, fault = page_state_error(pst, True)
            return {"ok": False, "error": err, "fault": fault, "pageState": pst, "selectorPackVersion": pack_version, "fingerprint": page_fingerprint(page, sel)}
        if body.get("kind") == "canary":
            return {
                "ok": True,
                "url": "",
                "text": "CANARY",
                "pageState": detect_page_state(page, "gemini"),
                "fingerprint": page_fingerprint(page, sel),
                "selectorPackVersion": pack_version,
            }
        box.click()
        box.fill(prompt)
        btn, _ = pick_locator(page, send, 4)
        try:
            if btn:
                btn.click()
            else:
                page.keyboard.press("Enter")
        except Exception:
            page.keyboard.press("Enter")
        deadline = time.time() + int(body.get("timeoutMs") or 90000) / 1000
        url = ""
        box_info = None
        while time.time() < deadline:
            imgs = page.locator("img")
            n = imgs.count()
            for i in range(n):
                el = imgs.nth(i)
                src = el.get_attribute("src") or ""
                try:
                    box_info = el.bounding_box()
                except Exception:
                    box_info = None
                if accept_result_image(src, baseline, box_info):
                    url = src
                    break
            if url:
                break
            time.sleep(0.6)
        if not url:
            return {"ok": False, "error": "IMAGE_NOT_FOUND: no new result image", "fault": "provider", "pageState": detect_page_state(page, "gemini")}
        if url.startswith("http"):
            try:
                resp = context.request.get(url, timeout=20000)
                raw = resp.body()
                mime = (resp.headers.get("content-type") or "image/png").split(";")[0]
                if "svg" in mime:
                    return {"ok": False, "error": "IMAGE_NOT_FOUND: svg placeholder rejected", "fault": "provider"}
                if not raw or len(raw) < 2048:
                    return {"ok": False, "error": "IMAGE_NOT_FOUND: image too small", "fault": "provider"}
                url = "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode())
            except Exception:
                return {"ok": False, "error": "IMAGE_NOT_FOUND: download failed", "fault": "provider"}
        if url.startswith("data:image/svg"):
            return {"ok": False, "error": "IMAGE_NOT_FOUND: svg placeholder rejected", "fault": "provider"}
        try:
            state_out = context.storage_state()
        except Exception:
            state_out = None
        return {
            "ok": True,
            "url": url,
            "sessionState": state_out,
            "sessionBaseVersion": int(body.get("sessionVersion") or 0),
            "sessionVersion": int(body.get("sessionVersion") or 0) + 1,
            "selectorPackVersion": pack_version,
            "pageState": "RESULT_READY",
        }

    if pool_enabled():
        browser, context, _fresh = get_pooled_context(proxy, state, body.get("accountId"))
        page = context.new_page()
        try:
            return run_image_on(page, context)
        finally:
            try:
                page.close()
            except Exception:
                pass
    with sync_playwright() as p:
        browser = open_browser(p, proxy)
        context = browser.new_context(
            storage_state=state if (state and (state.get("cookies") or state.get("origins"))) else None,
            locale="en-US",
            viewport={"width": 1365, "height": 900},
        )
        page = context.new_page()
        try:
            return run_image_on(page, context)
        finally:
            browser.close()

def make_image(prompt, images=None):
    import html, urllib.parse
    t = html.escape((prompt or "image")[:56])
    extra = " · 含参考图" if images else ""
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="768" height="432">'
        '<rect width="100%" height="100%" fill="#121212"/>'
        '<text x="48" y="210" fill="#e8e4d9" font-size="26" font-family="sans-serif">' + t + extra + "</text>"
        "</svg>"
    )
    return {"ok": True, "url": "data:image/svg+xml;charset=utf-8," + urllib.parse.quote(svg)}

def beat_loop():
    import urllib.request
    gw = (os.environ.get("RELAY_GATEWAY") or "").rstrip("/")
    token = os.environ.get("RELAY_TOKEN") or ""
    if not gw:
        return
    while True:
        if DRAINING and ACTIVE <= 0:
            break
        try:
            req = urllib.request.Request(
                gw + "/api/worker/next",
                headers={
                    "Authorization": "Bearer " + token,
                    "X-Worker-Name": os.environ.get("RELAY_WORKER_NAME") or "pc-1",
                    "X-Worker-Capacity": str(CAPACITY),
                    "X-Worker-Active": str(ACTIVE),
                    "X-Worker-Beat-Only": "1",
                    "X-Job-Id": os.environ.get("RELAY_JOB_ID") or "",
                    "X-Account-Id": os.environ.get("RELAY_ACCOUNT_ID") or "",
                    "X-Worker-Drain": "1" if DRAINING else "0",
                },
            )
            urllib.request.urlopen(req, timeout=8).read()
        except Exception:
            pass
        time.sleep(4)

def poll_gateway():
    import urllib.request
    gw = (os.environ.get("RELAY_GATEWAY") or "").rstrip("/")
    token = os.environ.get("RELAY_TOKEN") or ""
    if not gw:
        print("未设置网关地址，只提供本机 /chat")
        return
    print("拉取网关任务", gw, flush=True)
    fail = 0
    while True:
        if DRAINING and ACTIVE <= 0:
            print("drain complete", flush=True)
            break
        try:
            req = urllib.request.Request(
                gw + "/api/worker/next",
                headers={
                    "Authorization": "Bearer " + token,
                    "X-Worker-Name": os.environ.get("RELAY_WORKER_NAME") or "pc-1",
                    "X-Worker-Capacity": str(CAPACITY),
                    "X-Worker-Active": str(ACTIVE),
                    "X-Worker-Browsers": str(ACTIVE),
                    "X-Worker-Drain": "1" if DRAINING else "0",
                },
            )
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read().decode())
            fail = 0
            job = data.get("job")
            if not job:
                time.sleep(1.2)
                continue
            print("接到任务", job.get("id"), flush=True)
            payload = {
                "id": job.get("id"),
                "accountId": job.get("accountId") or data.get("accountId"),
                "prompt": job.get("prompt"),
                "images": job.get("images") or [],
                "storageState": data.get("storageState"),
                "proxy": data.get("proxy"),
                "timeoutMs": job.get("timeoutMs") or 90000,
                "model": job.get("model"),
                "sessionVersion": data.get("sessionVersion") or 0,
                "selectors": data.get("selectors") or job.get("selectors"),
                "selectorPackVersion": data.get("selectorPackVersion") or job.get("selectorPackVersion"),
                "turns": data.get("turns") or job.get("turns") or [],
                "kind": data.get("kind") or job.get("kind"),
                "leaseId": (data.get("lease") or {}).get("leaseId") or job.get("leaseId"),
                "fencingToken": (data.get("lease") or {}).get("fencingToken") or job.get("fencingToken"),
                "attemptId": (data.get("lease") or {}).get("attemptId") or job.get("attemptId"),
            }
            if job.get("platform") == "gemini":
                payload["platform"] = "gemini"
                payload["model"] = job.get("model") or "gemini-image"
            else:
                payload["model"] = job.get("model") or "gpt-5.6"
            try:
                result = exec_job(payload)
            except Exception as e:
                result = {"ok": False, "error": "WORKER_CRASH: %s" % str(e)[:240], "fault": "worker"}
            req2 = urllib.request.Request(
                gw + "/api/worker/result",
                data=json.dumps({
                    "id": job.get("id"),
                    "ok": result.get("ok"),
                    "text": result.get("text"),
                    "url": result.get("url"),
                    "error": result.get("error"),
                    "fault": result.get("fault"),
                    "leaseId": result.get("leaseId") or job.get("leaseId") or (data.get("lease") or {}).get("leaseId"),
                    "fencingToken": result.get("fencingToken") if result.get("fencingToken") is not None else job.get("fencingToken") or (data.get("lease") or {}).get("fencingToken"),
                    "attemptId": result.get("attemptId") or job.get("attemptId") or (data.get("lease") or {}).get("attemptId"),
                    "workerId": os.environ.get("RELAY_WORKER_NAME") or "server-1",
                    "sessionState": result.get("sessionState"),
                    "sessionVersion": result.get("sessionVersion"),
                    "sessionBaseVersion": result.get("sessionBaseVersion"),
                    "modelActual": result.get("modelActual"),
                    "pageState": result.get("pageState"),
                    "fingerprint": result.get("fingerprint"),
                    "selectorPackVersion": result.get("selectorPackVersion"),
                }, ensure_ascii=False).encode("utf-8"),
                headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req2, timeout=20).read()
        except Exception as e:
            fail += 1
            wait = min(8, 1.2 * fail)
            print("拉任务失败，%.1fs 后重连" % wait, e, flush=True)
            time.sleep(wait)


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == "__main__":
    def _drain(signum, frame):
        global DRAINING
        DRAINING = True
        print("SIGTERM drain", flush=True)
    try:
        import signal
        signal.signal(signal.SIGTERM, _drain)
        signal.signal(signal.SIGINT, _drain)
    except Exception:
        pass
    if len(sys.argv) > 2 and sys.argv[1] == "--job":
        with open(sys.argv[2], "r", encoding="utf-8") as f:
            payload = json.load(f)
        print(json.dumps(run_chat(payload), ensure_ascii=False))
        raise SystemExit(0)
    if TEST_URL in ("self", "1", "mock"):
        class M(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                return
            def do_GET(self):
                body = MOCK_HTML.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
        class MockServer(ThreadingMixIn, HTTPServer):
            daemon_threads = True
            allow_reuse_address = True
        mock = MockServer(("127.0.0.1", 0), M)
        mock_port = mock.server_address[1]
        threading.Thread(target=mock.serve_forever, daemon=True).start()
        CHAT_URL = "http://127.0.0.1:%d/" % mock_port
        print("测试页", CHAT_URL, flush=True)
    print("Relay 本机 Worker  http://127.0.0.1:%d" % PORT)
    print("请保持 v2rayN 开启，并选中平台同一条节点。不要关这个窗口。")
    if pick_proxy():
        print("已检测到本机代理")
    else:
        print("还没检测到 10808/10809，先开 v2rayN 再在平台点发送")
    threading.Thread(target=beat_loop, daemon=True).start()
    threading.Thread(target=poll_gateway, daemon=True).start()
    Server(("127.0.0.1", PORT), H).serve_forever()
`;
}
