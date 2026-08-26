#!/usr/bin/env python3
# Relay 本机 ChatGPT Worker。保持窗口开着，平台试运行会连过来。
import json, os, socket, ssl, subprocess, sys, tempfile, threading, time, base64, queue
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

SOCKS_OK_UNTIL = 0
SOCKS_OK_SERVER = ""

def socks_https_ok(proxy):
    global SOCKS_OK_UNTIL, SOCKS_OK_SERVER
    server = ""
    if isinstance(proxy, dict):
        server = proxy.get("server") or ""
    if not server.startswith("socks5"):
        return True
    if server == SOCKS_OK_SERVER and time.time() < SOCKS_OK_UNTIL:
        return True
    try:
        hostport = server.split("://", 1)[-1]
        sh, sp = hostport.rsplit(":", 1)
        sh = sh.strip("[]")
        dest = "api.ipify.org"
        s = socket.socket()
        s.settimeout(5)
        s.connect((sh, int(sp)))
        s.send(b"\x05\x01\x00")
        greet = s.recv(2)
        if not greet:
            s.close()
            return False
        req = b"\x05\x01\x00\x03" + bytes([len(dest)]) + dest.encode() + (443).to_bytes(2, "big")
        s.send(req)
        resp = s.recv(16)
        if not resp or len(resp) < 2 or resp[1] != 0:
            s.close()
            return False
        ctx = ssl.create_default_context()
        tls = ctx.wrap_socket(s, server_hostname=dest)
        tls.send(b"GET / HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n")
        body = tls.recv(256)
        tls.close()
        ok = bool(body)
        if ok:
            SOCKS_OK_SERVER = server
            SOCKS_OK_UNTIL = time.time() + 45
        return ok
    except Exception as e:
        print("socks_https_ok fail", server, e, flush=True)
        return False

def tunnel_down_error():
    return "PROXY_TUNNEL_DOWN: Shadowsocks 隧道暂时无法出网，正在使用本机可用 SOCKS。请稍后重试。"

def job_proxy(body):
    candidates = []
    p = body.get("proxy") or {}
    if isinstance(p, dict) and p.get("server"):
        candidates.append(p)
    alt = pick_proxy()
    if alt:
        server = alt.get("server")
        if not any((c.get("server") if isinstance(c, dict) else "") == server for c in candidates):
            candidates.append(alt)
    for c in candidates:
        server = (c.get("server") if isinstance(c, dict) else "") or ""
        if server.startswith("socks5"):
            try:
                sp = int(server.rsplit(":", 1)[-1])
            except Exception:
                sp = 0
            if sp and not port_open(sp):
                continue
            if socks_https_ok(c):
                return {"server": server}
            continue
        return c
    return pick_proxy()

def account_lock(aid):
    ACCOUNT_LOCKS.setdefault(aid or "_", threading.Lock())
    return ACCOUNT_LOCKS[aid or "_"]

def post_chunk(text, phase=""):
    if os.environ.get("RELAY_STREAM_CHUNKS") == "0" and text and not phase:
        return
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
            prompt = "\n".join([t for t in texts if t]).strip() or prompt
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
    if "captcha" in html or "cf-challenge" in html or "verify you are" in html or "turnstile" in html or "unusual traffic" in html or "just a moment" in html:
        return "CHALLENGE"
    if "deactivated" in html or "suspended" in html or "account has been disabled" in html or "restricted" in html:
        return "ACCOUNT_RESTRICTED"
    if "out of tokens" in html or "no tokens remaining" in html or "insufficient tokens" in html or "token bank empty" in html:
        return "TOKEN_EXHAUSTED"
    if "queue is full" in html or "too many pending generations" in html or "queue full" in html:
        return "QUEUE_FULL"
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
        if provider == "leonardo":
            try:
                if page.locator('a:has-text("Sign In"), a:has-text("Sign Up")').count() > 0:
                    return "LOGIN_REQUIRED"
            except Exception:
                pass
            composer = page.locator("#home-prompt-textarea, textarea[placeholder*='prompt' i]").first.count() > 0
            send = page.locator('button[aria-label="Generate"]').first.count() > 0
        elif provider == "gemini":
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
    if provider == "leonardo" and composer and send:
        return "IMAGE_GENERATOR_READY"
    if composer:
        return "COMPOSER_READY"
    if "chatgpt.com" in url or "gemini.google.com" in url or "leonardo.ai" in url:
        return "AUTHENTICATED"
    return "DOM_UNKNOWN"

def page_state_error(state, selector_failed=False, provider="chatgpt"):
    if state == "LOGIN_REQUIRED":
        if provider == "leonardo":
            return "LEONARDO_LOGIN_REQUIRED", "account"
        return "LOGIN_REQUIRED: provider login wall", "account"
    if state == "CHALLENGE":
        if provider == "leonardo":
            return "LEONARDO_CHALLENGE", "provider"
        return "CHALLENGE: captcha or bot wall", "provider"
    if state == "TOKEN_EXHAUSTED":
        return "LEONARDO_TOKEN_EXHAUSTED", "account"
    if state == "QUEUE_FULL":
        return "LEONARDO_QUEUE_FULL", "account"
    if state == "MODEL_UNAVAILABLE":
        return "LEONARDO_MODEL_UNAVAILABLE", "account"
    if state == "RATE_LIMITED":
        if provider == "leonardo":
            return "LEONARDO_RATE_LIMITED", "account"
        return "ACCOUNT_RATE_LIMIT: provider throttle", "account"
    if state == "ACCOUNT_RESTRICTED":
        if provider == "leonardo":
            return "LEONARDO_ACCOUNT_RESTRICTED", "account"
        return "ACCOUNT_BANNED: account disabled", "account"
    if state == "PROVIDER_ERROR":
        return "PROVIDER_UNAVAILABLE: provider error page", "provider"
    if selector_failed:
        if provider == "leonardo":
            return "LEONARDO_DOM_CHANGED: selector miss (page_state=%s)" % state, "provider"
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

def first_visible(page, names):
    loc, _sel = pick_locator(page, names, 4)
    return loc

def fill_composer(page, box, prompt):
    try:
        if box:
            box.click(timeout=1000)
            try:
                page.keyboard.press("Control+A")
            except Exception:
                pass
            page.keyboard.insert_text(prompt)
            if composer_text(page):
                return True
    except Exception:
        pass
    try:
        ok = page.evaluate(
            """(t) => {
              const el = document.querySelector('#prompt-textarea') || document.querySelector('[contenteditable="true"]');
              if (!el) return false;
              el.focus();
              if (el.tagName === 'TEXTAREA') {
                const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
                if (desc && desc.set) desc.set.call(el, t);
                else el.value = t;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return (el.value || '').trim().length > 0;
              }
              try { document.execCommand('selectAll'); } catch (e) {}
              let inserted = false;
              try { inserted = document.execCommand('insertText', false, t); } catch (e) {}
              if (!inserted || !(el.innerText || '').trim()) {
                el.textContent = t;
                el.dispatchEvent(new InputEvent('input', { bubbles: true, data: t, inputType: 'insertText' }));
              }
              return (el.innerText || el.textContent || '').trim().length > 0;
            }""",
            prompt,
        )
        if ok:
            return True
    except Exception:
        pass
    try:
        if box:
            box.fill(prompt, timeout=1000)
            return True
    except Exception:
        pass
    try:
        page.locator("#prompt-textarea").first.fill(prompt, timeout=1000)
        return True
    except Exception:
        return False

def click_send(page, btn):
    try:
        if send_button_enabled(page) and btn:
            btn.click(timeout=1500)
            return True
    except Exception:
        pass
    try:
        if btn:
            btn.click(timeout=1500, force=True)
            return True
    except Exception:
        pass
    try:
        page.keyboard.press("Enter")
        return True
    except Exception:
        return False

def send_button_enabled(page):
    try:
        return bool(page.evaluate("""() => {
          const b = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label*="Send"]');
          if (!b) return false;
          return !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b.getAttribute('data-disabled') !== 'true';
        }"""))
    except Exception:
        return False

def composer_text(page):
    try:
        return (page.evaluate("""() => {
          const el = document.querySelector('#prompt-textarea') || document.querySelector('[contenteditable="true"]');
          if (!el) return '';
          return (el.innerText || el.value || el.textContent || '').trim();
        }""") or "")
    except Exception:
        return ""

def wait_send_ack(page, before_user, before_as, timeout_ms=None, stop_sels=None, had_text=None):
    sels = stop_sels or ["button[aria-label='Stop streaming']", "button[aria-label='Stop generating']", "button[data-testid='stop-button']"]
    deadline = time.time() + (timeout_ms or SEND_ACK_TIMEOUT) / 1000.0
    while time.time() < deadline:
        try:
            if page.locator("[data-message-author-role='user']").count() > before_user:
                return True
            if page.locator("[data-message-author-role='assistant']").count() > before_as:
                return True
            if page.locator("[data-turn='user'], [data-testid*='conversation-turn']").count() > before_user:
                return True
            if page.locator(",".join(sels)).first.is_visible():
                return True
            if had_text and not composer_text(page):
                return True
        except Exception:
            pass
        time.sleep(0.08)
    return False

def submit_prompt(page, prompt, inp, send, stop_sels=None):
    box = first_visible(page, inp)
    if box is None:
        return False
    if not fill_composer(page, box, prompt):
        return False
    waited = time.time() + 2
    while time.time() < waited and not send_button_enabled(page):
        time.sleep(0.1)
    before_as = page.locator("[data-message-author-role='assistant']").count()
    before_user = page.locator("[data-message-author-role='user']").count()
    filled = composer_text(page)
    click_send(page, first_visible(page, send))
    if wait_send_ack(page, before_user, before_as, None, stop_sels, filled):
        return True
    try:
        page.keyboard.press("Enter")
    except Exception:
        pass
    if wait_send_ack(page, before_user, before_as, 2000, stop_sels, filled):
        return True
    if filled and not composer_text(page):
        return True
    return False

PAGE_READY_TIMEOUT = 8000
COMPOSER_READY_TIMEOUT = 4000
INPUT_TIMEOUT = 1000
SEND_BUTTON_TIMEOUT = 1500
SEND_ACK_TIMEOUT = 4000
WARM_MAX_REQ = int(os.environ.get("RELAY_WARM_MAX_REQ") or "20")
WARM_MAX_AGE = int(os.environ.get("RELAY_WARM_MAX_AGE") or "2700")

def detect_profile(page):
    blob = ""
    try:
        blob = (page.evaluate("() => (document.body && document.body.innerText || '').slice(0, 6000)") or "")
    except Exception:
        blob = ""
    low = blob.lower()
    instant = any(x in low for x in ("instant", "快速响应", "fast"))
    thinking = any(x in low for x in ("thinking", "reasoning", "sol", "深度研究"))
    return {
        "instant_visible": bool(instant),
        "reasoning_visible": bool(thinking),
        "actual_profile": "unknown",
        "profile_verified": False,
        "fast_capable": False,
    }

def install_mut_observer(page, before):
    page.evaluate(
        """(before) => {
          window.__relayPrev = '';
          window.__relayFull = '';
          window.__relayDeltas = [];
          window.__relayBefore = before || 0;
          const read = () => {
            const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
            if (nodes.length <= window.__relayBefore) return '';
            return (nodes[nodes.length - 1].innerText || '').trim();
          };
          const tick = () => {
            const t = read();
            if (!t) return;
            if (t === window.__relayFull) return;
            let d = '';
            if (t.startsWith(window.__relayPrev)) d = t.slice(window.__relayPrev.length);
            else d = t;
            window.__relayPrev = t;
            window.__relayFull = t;
            if (d) window.__relayDeltas.push(d);
          };
          if (window.__relayObs) try { window.__relayObs.disconnect(); } catch (e) {}
          const obs = new MutationObserver(tick);
          obs.observe(document.body, { subtree: true, childList: true, characterData: true });
          window.__relayObs = obs;
          tick();
        }""",
        before,
    )

def drain_deltas(page):
    try:
        return page.evaluate(
            """() => {
              const d = window.__relayDeltas || [];
              window.__relayDeltas = [];
              return { deltas: d, full: window.__relayFull || '' };
            }"""
        ) or {"deltas": [], "full": ""}
    except Exception:
        return {"deltas": [], "full": ""}

def js_new_chat(page):
    try:
        page.evaluate(
            """() => {
              const b = document.querySelector('[data-testid="create-new-chat-button"]');
              if (b) b.click();
            }"""
        )
        return True
    except Exception:
        return False

def recover_page(page, context, level, real):
    target = "https://chatgpt.com/?temporary-chat=true" if real else CHAT_URL
    if level <= 1:
        return page, 1
    if level == 2:
        try:
            page.reload(wait_until="domcontentloaded", timeout=PAGE_READY_TIMEOUT)
        except Exception:
            pass
        return page, 2
    if level >= 3:
        try:
            page.close()
        except Exception:
            pass
        page = context.new_page()
        arm_page(page)
        try:
            page.set_default_timeout(4000)
        except Exception:
            pass
        page.goto(target, wait_until="domcontentloaded", timeout=25000)
        return page, 3
    return page, level

def composer_ready(page, timeout_ms):
    try:
        page.wait_for_selector("#prompt-textarea, textarea#prompt-textarea", timeout=timeout_ms)
        return True
    except Exception:
        return False


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
    if "googleusercontent" in src or "leonardo.ai" in src or "leonardousercontent" in src or (src.startswith("data:image") and len(src) > 800):
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
        note = ("\n[attached:%d image(s)]" % len(imgs)) if imgs else ""
        cur = ' current="true"' if i == last_i else ""
        blocks.append("<relay:%s%s>\n%s%s\n</relay:%s>" % (role, cur, text, note, role))
    return "\n\n".join(blocks).strip()

PW = None
PW_THREAD = None
PW_Q = queue.Queue()
BROWSER_POOL = {}
CTX_POOL = {}
POOL_LOCK = threading.Lock()
MAX_BROWSERS = int(os.environ.get("RELAY_MAX_BROWSERS") or "4")
MAX_CTX = int(os.environ.get("RELAY_MAX_CTX_PER_BROWSER") or "8")
CTX_IDLE = int(os.environ.get("RELAY_CTX_IDLE") or "600")
CTX_MAX_REQ = int(os.environ.get("RELAY_CTX_MAX_REQ") or "20")

def reset_playwright():
    global PW, BROWSER_POOL, CTX_POOL
    for row in list(CTX_POOL.values()):
        try:
            if row.get("page"):
                row["page"].close()
        except Exception:
            pass
        try:
            if row.get("ctx"):
                row["ctx"].close()
        except Exception:
            pass
    CTX_POOL.clear()
    for b in list(BROWSER_POOL.values()):
        try:
            b.close()
        except Exception:
            pass
    BROWSER_POOL.clear()
    try:
        if PW:
            PW.stop()
    except Exception:
        pass
    PW = None

def playwright_inst():
    global PW
    if PW is None:
        from playwright.sync_api import sync_playwright
        PW = sync_playwright().start()
    return PW

def noise_route(route):
    u = route.request.url
    if any(x in u for x in ("google-analytics", "googletagmanager", "doubleclick", "segment.", "hotjar", "fullstory", "intercom.io", "facebook.net")):
        return route.abort()
    return route.continue_()

def arm_page(page):
    try:
        page.route("**/*", noise_route)
    except Exception:
        pass

def warm_sessions():
    playwright_inst()
    proxy = pick_proxy() or {"server": "socks5://127.0.0.1:18080"}
    sess_dir = os.path.join(HERE, "sessions")
    found = []
    if os.path.isdir(sess_dir):
        for n in os.listdir(sess_dir):
            path = os.path.join(sess_dir, n)
            try:
                if n.endswith(".json") and os.path.getsize(path) > 5000:
                    found.append((n[:-5], path))
            except Exception:
                continue
    if not found:
        get_pooled_context(proxy, None, "_warm")
        print("browser warm", flush=True)
        return
    for aid, path in found[:3]:
        try:
            with open(path, "r", encoding="utf-8") as f:
                state = json.load(f)
            if not (state.get("cookies") or []):
                continue
            browser, ctx, page, key = get_pooled_context(proxy, state, aid)
            if page is None:
                page = ctx.new_page()
                arm_page(page)
                page.goto("https://chatgpt.com/?temporary-chat=true", wait_until="domcontentloaded", timeout=25000)
                page.wait_for_selector("#prompt-textarea, textarea#prompt-textarea", timeout=15000)
            with POOL_LOCK:
                row = CTX_POOL.get(key)
                if row:
                    row["page"] = page
            print("session warm", aid[:8], flush=True)
        except Exception as e:
            print("session warm fail", aid[:8], e, flush=True)

def pw_loop():
    global PW_THREAD
    PW_THREAD = threading.current_thread()
    try:
        warm_sessions()
    except Exception as e:
        print("warmup fail", e, flush=True)
    while True:
        item = PW_Q.get()
        if item is None:
            break
        body, box = item
        try:
            result = exec_job_run(body)
        except Exception as e:
            msg = str(e)
            if "cannot switch to a different thread" in msg or "has exited" in msg:
                reset_playwright()
                try:
                    playwright_inst()
                    result = exec_job_run(body)
                except Exception as e2:
                    result = {"ok": False, "error": "WORKER_CRASH: %s" % str(e2)[:240], "fault": "worker"}
            else:
                result = {"ok": False, "error": "WORKER_CRASH: %s" % msg[:240], "fault": "worker"}
        box["result"] = result
        box["ev"].set()

def pool_enabled():
    if os.environ.get("RELAY_TEST_URL"):
        return False
    return os.environ.get("RELAY_BROWSER_POOL", "1") != "0"

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
            return browser, row["ctx"], row.get("page"), ctx_key
        if row:
            try:
                if row.get("page"):
                    row["page"].close()
            except Exception:
                pass
            try:
                row["ctx"].close()
            except Exception:
                pass
            CTX_POOL.pop(ctx_key, None)
        same = [k for k in CTX_POOL if k.startswith(proxy_key + "|")]
        if len(same) >= MAX_CTX:
            old = same[0]
            try:
                if CTX_POOL[old].get("page"):
                    CTX_POOL[old]["page"].close()
            except Exception:
                pass
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
        try:
            ctx.set_default_timeout(4000)
            ctx.set_default_navigation_timeout(25000)
        except Exception:
            pass
        CTX_POOL[ctx_key] = {"ctx": ctx, "last": time.time(), "n": 1, "page": None, "born": time.time()}
        return browser, ctx, None, ctx_key


def open_browser(p, proxy):
    args = ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"]
    ignore = ["--enable-automation"]
    kw = {"headless": HEADLESS, "args": args, "ignore_default_args": ignore}
    if proxy:
        kw["proxy"] = proxy
    if not HEADLESS:
        for channel in ("chrome", "msedge"):
            try:
                return p.chromium.launch(channel=channel, **kw)
            except Exception:
                pass
    return p.chromium.launch(**kw)

def select_model(page, model):
    latest = model in ("gpt-5.6", "latest", "gpt-5")
    if latest:
        try:
            if page.locator("#prompt-textarea, textarea#prompt-textarea").count() > 0:
                return True, "ChatGPT"
        except Exception:
            pass
    labels = {
        "gpt-5.6": ["GPT-5.6", "5.6", "5.2", "Instant", "ChatGPT", "Auto", "GPT-5"],
        "latest": ["GPT-5.6", "GPT-5", "Instant", "ChatGPT", "Auto"],
        "gpt-5": ["GPT-5 Auto", "Auto", "GPT-5", "ChatGPT", "Instant"],
        "gpt-5-thinking": ["GPT-5 Thinking", "Thinking"],
        "gpt-4o": ["GPT-4o", "4o"],
    }.get(model, [model])
    switchers = [
        '[data-testid="model-switcher-dropdown-button"]',
        'button:has-text("ChatGPT 5")',
        'button:has-text("GPT-5")',
        'button:has-text("Instant")',
        '[aria-label*="Model"]',
        '[aria-label*="model"]',
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
    if switcher:
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
    if not actual:
        try:
            t = (page.locator("header, nav").first.inner_text() or "")
            for lab in ("ChatGPT 5.2", "ChatGPT 5.4", "ChatGPT 5.6", "GPT-5", "Instant", "ChatGPT"):
                if lab.lower() in t.lower():
                    actual = lab
                    break
        except Exception:
            actual = actual or ""
    if latest and page.locator("#prompt-textarea, textarea#prompt-textarea").count() > 0:
        if not actual:
            actual = "ChatGPT"
        return True, actual
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
    if not TEST_URL and not socks_https_ok(proxy):
        return {"ok": False, "error": tunnel_down_error(), "fault": "proxy"}

    def first_visible(page, names):
        loc, _sel = pick_locator(page, names, 4)
        return loc

    def run_on(page, context, close_browser):
        t0 = time.time()
        marks = {}
        recovery_level = 0
        def mark(name):
            marks[name] = int((time.time() - t0) * 1000)
            print("T %s %dms" % (name, marks[name]), flush=True)
        mark("T0")
        try:
            page.set_default_timeout(4000)
        except Exception:
            pass
        arm_page(page)
        net = {"req": None, "res": None}
        def on_req(req):
            u = req.url or ""
            if net["req"] is None and any(x in u for x in ("/backend-api/", "/conversation")):
                net["req"] = time.time()
        def on_res(res):
            u = res.url or ""
            if net["res"] is None and any(x in u for x in ("/backend-api/", "/conversation")):
                net["res"] = time.time()
        try:
            page.on("request", on_req)
            page.on("response", on_res)
        except Exception:
            pass
        mark("T2")
        post_phase("opening_chatgpt")
        already = False
        try:
            already = "chatgpt.com" in (page.url or "") and page.locator("#prompt-textarea, textarea#prompt-textarea").count() > 0
        except Exception:
            already = False
        if already:
            js_new_chat(page)
            if not composer_ready(page, COMPOSER_READY_TIMEOUT):
                page, recovery_level = recover_page(page, context, 2, real)
                if not composer_ready(page, PAGE_READY_TIMEOUT):
                    page, recovery_level = recover_page(page, context, 3, real)
                    if not composer_ready(page, PAGE_READY_TIMEOUT):
                        pst = detect_page_state(page, "chatgpt")
                        err, fault = page_state_error(pst, True)
                        return {"ok": False, "error": err, "fault": fault, "pageState": pst, "recoveryLevel": recovery_level, "timing": marks}
        else:
            target = CHAT_URL if not real else "https://chatgpt.com/?temporary-chat=true"
            try:
                page.goto(target, wait_until="domcontentloaded", timeout=25000)
            except Exception as e:
                t = str(e)
                if "ERR_CONNECTION_CLOSED" in t or "ERR_CONNECTION_RESET" in t or "ERR_TUNNEL" in t:
                    return {"ok": False, "error": tunnel_down_error(), "fault": "proxy", "timing": marks}
                page, recovery_level = recover_page(page, context, 3, real)
            if not composer_ready(page, PAGE_READY_TIMEOUT):
                pst = detect_page_state(page, "chatgpt")
                if pst == "CHALLENGE":
                    err, fault = page_state_error(pst, False)
                    return {"ok": False, "error": err, "fault": fault, "pageState": pst, "timing": marks}
                page, recovery_level = recover_page(page, context, 3, real)
                if not composer_ready(page, PAGE_READY_TIMEOUT):
                    pst = detect_page_state(page, "chatgpt")
                    err, fault = page_state_error(pst, True)
                    return {"ok": False, "error": err, "fault": fault, "pageState": pst, "recoveryLevel": recovery_level, "timing": marks}
        mark("T3")
        post_phase("page_ready")
        profile = detect_profile(page)
        switched, actual = select_model(page, model)
        if not switched and not TEST_URL:
            code = "MODEL_SELECTION_UNCONFIRMED" if not actual else "MODEL_MISMATCH"
            return {"ok": False, "error": code + ": failed to select " + model, "fault": "provider", "modelActual": actual or "", "timing": marks, "profile": profile}
        if images:
            attach_images(page, images)
        box = first_visible(page, inp)
        if box is None:
            page, recovery_level = recover_page(page, context, 2, real)
            composer_ready(page, COMPOSER_READY_TIMEOUT)
            box = first_visible(page, inp)
        if box is None:
            pst = detect_page_state(page, "chatgpt")
            err, fault = page_state_error(pst, True)
            return {"ok": False, "error": err, "fault": fault, "pageState": pst, "selectorPackVersion": pack_version, "fingerprint": page_fingerprint(page, sel), "recoveryLevel": recovery_level, "timing": marks}
        mark("T4")
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
                "profile": profile,
                "timing": marks,
                "sessionBaseVersion": int(body.get("sessionVersion") or 0),
                "sessionVersion": int(body.get("sessionVersion") or 0) + 1,
            }
        mark("T5")
        install_mut_observer(page, page.locator("div[data-message-author-role='assistant']").count())
        acked = submit_prompt(page, prompt, inp, send, stop)
        mark("T6")
        if not acked:
            page, recovery_level = recover_page(page, context, 3, real)
            composer_ready(page, COMPOSER_READY_TIMEOUT)
            switched, actual = select_model(page, model)
            install_mut_observer(page, page.locator("div[data-message-author-role='assistant']").count())
            acked = submit_prompt(page, prompt, inp, send, stop)
        if not acked and not TEST_URL:
            try:
                print("SEND_NOT_ACKED url", page.url, "send_on", send_button_enabled(page), "composer", composer_text(page)[:80], flush=True)
            except Exception:
                pass
            return {"ok": False, "error": "SEND_NOT_ACKED: message did not enter conversation", "fault": "provider", "recoveryLevel": recovery_level, "timing": marks}
        mark("T7")
        post_phase("generating")
        stop_sel = ",".join(stop)
        deadline = time.time() + timeout_ms / 1000
        text = ""
        last_change = time.time()
        stop_seen = False
        first_delta = False
        while time.time() < deadline:
            generating = False
            try:
                generating = bool(page.locator(stop_sel).first.is_visible())
                if generating:
                    stop_seen = True
            except Exception:
                generating = False
            drained = drain_deltas(page)
            full = (drained.get("full") or "").strip()
            if full:
                if not first_delta:
                    first_delta = True
                    mark("T8")
                    post_chunk(full)
                    last_change = time.time()
                elif drained.get("deltas"):
                    post_chunk(full)
                    last_change = time.time()
                text = full
            idle = time.time() - last_change
            if text and not generating and idle >= 0.45:
                break
            if text and idle >= 1.8:
                break
            time.sleep(0.08)
        mark("T9")
        if not text:
            pst = detect_page_state(page, "chatgpt")
            return {"ok": False, "error": "TIMEOUT: empty assistant", "fault": "provider", "pageState": pst, "timing": marks, "profile": profile}
        if "sol" in text.lower() or "reasoning" in text.lower() or "推理" in text:
            profile["actual_profile"] = "reasoning"
            profile["profile_verified"] = False
            profile["fast_capable"] = False
        elif "instant" in text.lower():
            profile["actual_profile"] = "instant"
            profile["profile_verified"] = False
        mark("T10")
        def g(a, b=None):
            if b is None:
                return marks.get(a, 0)
            return max(0, marks.get(b, 0) - marks.get(a, 0))
        timing = {
            "marks": marks,
            "queue_wait_ms": 0,
            "lease_ms": 0,
            "browser_prepare_ms": g("T2"),
            "page_ready_ms": g("T2", "T3"),
            "composer_ready_ms": g("T3", "T4"),
            "input_ms": g("T4", "T5"),
            "send_ms": g("T5", "T6"),
            "submit_to_first_delta_ms": g("T6", "T8") if "T8" in marks else None,
            "first_delta_to_complete_ms": g("T8", "T9") if "T8" in marks else None,
            "generation_ms": g("T6", "T9"),
            "send_to_network_activity_ms": int((net["req"] - t0) * 1000) - marks.get("T6", 0) if net["req"] else None,
            "network_to_dom_ms": int((marks.get("T8", 0)) - int((net["res"] - t0) * 1000)) if (net["res"] and "T8" in marks) else None,
            "recovery_level": recovery_level,
            "recovery_ms": 0,
            "total_ms": g("T10"),
            "warm_page": bool(already),
        }
        print("TIMING", json.dumps(timing, ensure_ascii=False), flush=True)
        return {
            "ok": True,
            "text": text,
            "sessionBaseVersion": int(body.get("sessionVersion") or 0),
            "sessionVersion": int(body.get("sessionVersion") or 0) + 1,
            "modelActual": actual or model,
            "actualProfile": profile.get("actual_profile"),
            "profileVerified": bool(profile.get("profile_verified")),
            "fastCapable": bool(profile.get("fast_capable")),
            "selectorPackVersion": pack_version,
            "pageState": "RESULT_READY",
            "latencyMs": timing["total_ms"],
            "timing": timing,
            "profile": profile,
            "recoveryLevel": recovery_level,
        }

    if pool_enabled():
        browser, context, page, ctx_key = get_pooled_context(proxy, state, body.get("accountId"))
        if page is None:
            page = context.new_page()
        try:
            result = run_on(page, context, False)
            with POOL_LOCK:
                row = CTX_POOL.get(ctx_key)
                if row:
                    row["page"] = page
            return result
        except Exception as e:
            return {"ok": False, "error": "WORKER_CRASH: %s" % str(e)[:240], "fault": "worker"}
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
        msg = fmt % args
        if "GET / HTTP" in msg or "GET /health" in msg:
            return
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), msg))

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
            model = (body.get("model") or "")
            body["platform"] = "leonardo" if str(model).startswith("leonardo-") else "gemini"
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
    if PW_THREAD is not None and threading.current_thread() is PW_THREAD:
        return exec_job_run(body)
    ev = threading.Event()
    box = {"ev": ev, "result": None}
    PW_Q.put((body, box))
    timeout = int(body.get("timeoutMs") or 90000) / 1000.0 + 30
    if not ev.wait(timeout):
        return {"ok": False, "error": "WORKER_CRASH: playwright queue timeout", "fault": "worker"}
    return box["result"] or {"ok": False, "error": "WORKER_CRASH: empty result", "fault": "worker"}

def exec_job_run(body):
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
        if body.get("platform") in ("gemini", "image", "leonardo") or body.get("kind") == "image":
            if body.get("platform") == "leonardo" or str(body.get("model") or "").startswith("leonardo-"):
                return run_leonardo(body)
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
        if not fill_composer(page, box, prompt):
            return {"ok": False, "error": "PROVIDER_DOM_CHANGED: cannot fill composer", "fault": "provider"}
        send_btn, _ = pick_locator(page, send, 4)
        click_send(page, send_btn)
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
        browser, context, page, ctx_key = get_pooled_context(proxy, state, body.get("accountId"))
        if page is None:
            page = context.new_page()
        try:
            result = run_image_on(page, context)
            with POOL_LOCK:
                row = CTX_POOL.get(ctx_key)
                if row:
                    row["page"] = page
            return result
        except Exception as e:
            return {"ok": False, "error": "WORKER_CRASH: %s" % str(e)[:240], "fault": "worker"}
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

def size_to_aspect(size):
    try:
        parts = str(size or "1024x1024").lower().replace(" ", "").split("x")
        w, h = int(parts[0]), int(parts[1])
        r = w / float(h)
    except Exception:
        return "1:1"
    opts = [("1:1", 1.0), ("4:3", 4.0/3), ("16:9", 16.0/9), ("4:5", 4.0/5), ("2:3", 2.0/3), ("9:16", 9.0/16)]
    best, dist = "1:1", 99.0
    for lab, ar in opts:
        d = abs(r - ar)
        if d < dist:
            dist, best = d, lab
    return best

def download_result_image(context, url):
    if not url:
        return None, "LEONARDO_RESULT_NOT_FOUND"
    if url.startswith("data:image/svg"):
        return None, "LEONARDO_RESULT_NOT_FOUND: svg rejected"
    if url.startswith("data:image"):
        return url, None
    if url.startswith("http"):
        try:
            resp = context.request.get(url, timeout=20000)
            raw = resp.body()
            mime = (resp.headers.get("content-type") or "image/png").split(";")[0]
            if "svg" in mime:
                return None, "LEONARDO_RESULT_NOT_FOUND: svg rejected"
            if not raw or len(raw) < 2048:
                return None, "LEONARDO_RESULT_NOT_FOUND: image too small"
            return "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode()), None
        except Exception:
            return None, "LEONARDO_DOWNLOAD_FAILED"
    return None, "LEONARDO_RESULT_NOT_FOUND"

def run_leonardo(body):
    from playwright.sync_api import sync_playwright
    prompt, images = extract_prompt_images(body)
    if not prompt and images:
        prompt = "根据参考图生成一张新图"
    if not prompt:
        return {"ok": False, "error": "LEONARDO_GENERATION_FAILED: empty prompt", "fault": "client", "backendMode": "web_account"}
    state = body.get("storageState")
    if TEST_URL:
        return {"ok": False, "error": "LEONARDO_GENERATION_FAILED: mock forbidden in web_account", "fault": "provider", "mode": "mock", "backendMode": "web_account"}
    if not state:
        return {"ok": False, "error": "LEONARDO_LOGIN_REQUIRED: no storage state", "fault": "account", "backendMode": "web_account"}
    model = (body.get("model") or "leonardo-gemini").strip()
    gpt = "gpt-image" in model
    labels = ["GPT Image 2", "GPT Image", "gpt-image-2"] if gpt else ["Nano Banana 2", "Nano Banana", "Gemini Image 2", "Gemini 2.5 Flash Image", "gemini-image-2", "Gemini 2.5"]
    proxy = job_proxy(body)
    if not proxy:
        return {"ok": False, "error": "LEONARDO_PROXY_UNAVAILABLE: job missing account-bound proxy", "fault": "proxy", "backendMode": "web_account"}
    if not socks_https_ok(proxy):
        return {"ok": False, "error": tunnel_down_error(), "fault": "proxy", "backendMode": "web_account"}
    target = os.environ.get("LEONARDO_URL") or "https://app.leonardo.ai/generate"
    home = "https://app.leonardo.ai/"
    want_n = int(body.get("n") or 1)
    want_size = body.get("size") or "1024x1024"
    want_quality = str(body.get("quality") or "MEDIUM").upper()
    kind = body.get("kind") or "image"
    pack_version = body.get("selectorPackVersion") or "leonardo-image-v1"

    def enum_model_labels(page):
        found = []
        try:
            page.evaluate("() => { var n = document.querySelector('[aria-label^=Model]'); if (n) n.click(); }")
            page.wait_for_timeout(500)
            texts = page.evaluate("""() => [...document.querySelectorAll('[role=menuitem], [role=option], button, [data-slot=dropdown-menu-item]')].map(e => (e.innerText||'').trim()).filter(t => t && t.length < 80)""")
            if isinstance(texts, list):
                for t in texts:
                    if t and t not in found:
                        found.append(t)
        except Exception:
            pass
        return found

    def run_on(page, context):
        t0 = time.time()
        arm_page(page)
        try:
            page.set_default_timeout(4000)
        except Exception:
            pass
        try:
            page.goto(target, wait_until="domcontentloaded", timeout=25000)
        except Exception:
            page.goto(home, wait_until="domcontentloaded", timeout=25000)
        page.wait_for_timeout(1200)
        pst = detect_page_state(page, "leonardo")
        if pst in ("LOGIN_REQUIRED", "CHALLENGE", "TOKEN_EXHAUSTED", "QUEUE_FULL", "RATE_LIMITED", "ACCOUNT_RESTRICTED"):
            err, fault = page_state_error(pst, False, "leonardo")
            return {"ok": False, "error": err, "fault": fault, "pageState": pst, "backendMode": "web_account", "selectorPackVersion": pack_version}
        box = page.locator("#home-prompt-textarea, textarea[placeholder*='prompt' i]").first
        gen = page.locator('button[aria-label="Generate"]').first
        if box.count() == 0 or gen.count() == 0:
            err, fault = page_state_error(pst or "DOM_UNKNOWN", True, "leonardo")
            return {"ok": False, "error": err, "fault": fault, "pageState": pst, "backendMode": "web_account"}
        available = enum_model_labels(page)
        picked = ""
        for lab in labels:
            for item in available:
                if lab.lower() in item.lower() or item.lower() in lab.lower():
                    picked = item
                    break
            if picked:
                break
        if not available:
            return {"ok": False, "error": "LEONARDO_DOM_CHANGED: model menu empty", "fault": "provider", "pageState": "MODEL_SELECTOR_READY", "backendMode": "web_account", "availableModels": []}
        if not picked:
            return {"ok": False, "error": "LEONARDO_MODEL_UNAVAILABLE: " + model, "fault": "account", "pageState": "MODEL_UNAVAILABLE", "backendMode": "web_account", "availableModels": available, "modelActual": ""}
        try:
            page.get_by_text(picked, exact=False).first.click(timeout=1500, force=True)
        except Exception:
            page.evaluate("(t) => { const n=[...document.querySelectorAll('[role=menuitem],button,[role=option]')].find(e => (e.innerText||'').includes(t)); if(n) n.click(); }", picked)
        if kind == "canary":
            return {
                "ok": True,
                "url": "",
                "text": "CANARY",
                "pageState": detect_page_state(page, "leonardo"),
                "modelActual": picked,
                "availableModels": available,
                "backendMode": "web_account",
                "selectorPackVersion": pack_version,
            }
        aspect = size_to_aspect(want_size)
        try:
            page.locator('button[aria-label="Aspect ratio: %s"]' % aspect).first.click(timeout=1200, force=True)
        except Exception:
            pass
        if want_quality in ("HIGH", "LOW"):
            qhit = False
            for qlab in (want_quality, want_quality.title(), "Quality: " + want_quality.title()):
                loc = page.get_by_text(qlab, exact=False).first
                if loc.count() > 0:
                    try:
                        loc.click(timeout=800, force=True)
                        qhit = True
                        break
                    except Exception:
                        pass
            if not qhit:
                return {"ok": False, "error": "LEONARDO_DOM_CHANGED: quality control missing", "fault": "provider", "backendMode": "web_account", "availableModels": available}
        if want_n > 1:
            n_hit = False
            for sel in ('[aria-label*="Number of images"]', '[aria-label*="Quantity"]', 'button:has-text("%d")' % want_n):
                loc = page.locator(sel).first
                if loc.count() > 0:
                    try:
                        loc.click(timeout=800, force=True)
                        n_hit = True
                        break
                    except Exception:
                        pass
            if not n_hit:
                return {"ok": False, "error": "LEONARDO_DOM_CHANGED: quantity control missing for n=%d" % want_n, "fault": "provider", "backendMode": "web_account", "availableModels": available}
        baseline = snapshot_image_srcs(page)
        if not fill_composer(page, box, prompt):
            try:
                box.fill(prompt, timeout=1000)
            except Exception:
                return {"ok": False, "error": "LEONARDO_DOM_CHANGED: cannot fill prompt", "fault": "provider", "backendMode": "web_account"}
        if images:
            try:
                page.locator('button[aria-label="Add image reference"]').first.click(timeout=1500, force=True)
            except Exception:
                pass
            fi = page.locator("input[type=file]").first
            paths = []
            for i, u in enumerate(images[:6]):
                path = os.path.join(tempfile.gettempdir(), "leo-ref-%d.png" % i)
                if u.startswith("data:"):
                    raw = u.split(",", 1)[-1]
                    open(path, "wb").write(base64.b64decode(raw))
                    paths.append(path)
            if paths and fi.count() > 0:
                try:
                    fi.set_input_files(paths)
                except Exception:
                    return {"ok": False, "error": "LEONARDO_DOM_CHANGED: cannot upload references", "fault": "provider", "backendMode": "web_account"}
            elif paths and fi.count() == 0:
                return {"ok": False, "error": "LEONARDO_DOM_CHANGED: file input missing", "fault": "provider", "backendMode": "web_account"}
        try:
            gen.click(timeout=1500, force=True)
        except Exception:
            page.keyboard.press("Enter")
        page.wait_for_timeout(800)
        pst2 = detect_page_state(page, "leonardo")
        if pst2 in ("LOGIN_REQUIRED", "TOKEN_EXHAUSTED", "QUEUE_FULL", "CHALLENGE"):
            err, fault = page_state_error(pst2, False, "leonardo")
            return {"ok": False, "error": err, "fault": fault, "pageState": pst2, "backendMode": "web_account", "availableModels": available}
        deadline = time.time() + int(body.get("timeoutMs") or 120000) / 1000
        url_out = ""
        while time.time() < deadline:
            html2 = ""
            try:
                html2 = (page.content() or "")[:8000]
            except Exception:
                html2 = ""
            low = html2.lower()
            if "out of tokens" in low or "insufficient tokens" in low:
                return {"ok": False, "error": "LEONARDO_TOKEN_EXHAUSTED", "fault": "account", "pageState": "TOKEN_EXHAUSTED", "backendMode": "web_account", "tokenState": "TOKEN_EXHAUSTED", "availableModels": available}
            for src in snapshot_image_srcs(page):
                if src in baseline:
                    continue
                if accept_result_image(src, baseline, None):
                    url_out = src
                    break
            if url_out:
                break
            time.sleep(0.5)
        if not url_out:
            return {"ok": False, "error": "LEONARDO_RESULT_NOT_FOUND", "fault": "provider", "pageState": "GENERATION_FAILED", "backendMode": "web_account", "availableModels": available, "modelActual": picked}
        data_url, derr = download_result_image(context, url_out)
        if not data_url:
            return {"ok": False, "error": derr or "LEONARDO_DOWNLOAD_FAILED", "fault": "provider", "backendMode": "web_account", "availableModels": available}
        try:
            state_out = context.storage_state()
        except Exception:
            state_out = None
        return {
            "ok": True,
            "url": data_url,
            "modelActual": picked or model,
            "backendMode": "web_account",
            "latencyMs": int((time.time() - t0) * 1000),
            "pageState": "GENERATION_COMPLETE",
            "availableModels": available,
            "selectorPackVersion": pack_version,
            "sessionState": state_out,
            "sessionBaseVersion": int(body.get("sessionVersion") or 0),
            "sessionVersion": int(body.get("sessionVersion") or 0) + 1,
        }

    if pool_enabled():
        browser, context, page, ctx_key = get_pooled_context(proxy, state, body.get("accountId"))
        if page is None:
            page = context.new_page()
        try:
            result = run_on(page, context)
            with POOL_LOCK:
                row = CTX_POOL.get(ctx_key)
                if row:
                    row["page"] = page
            return result
        except Exception as e:
            return {"ok": False, "error": "WORKER_CRASH: %s" % str(e)[:240], "fault": "worker", "backendMode": "web_account"}
    with sync_playwright() as p:
        browser = open_browser(p, proxy)
        context = browser.new_context(
            storage_state=state if (state and (state.get("cookies") or state.get("origins"))) else None,
            locale="en-US",
            viewport={"width": 1440, "height": 900},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        page = context.new_page()
        try:
            return run_on(page, context)
        finally:
            browser.close()

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
            elif job.get("platform") == "leonardo":
                payload["platform"] = "leonardo"
                payload["model"] = job.get("model") or "leonardo-gemini"
                payload["n"] = job.get("n") or 1
                payload["size"] = job.get("size") or "1024x1024"
                payload["quality"] = job.get("quality") or "MEDIUM"
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
                    "availableModels": result.get("availableModels"),
                    "tokenState": result.get("tokenState"),
                    "backendMode": result.get("backendMode") or "web_account",
                    "queueDepth": result.get("queueDepth"),
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
    print("Relay Worker  http://127.0.0.1:%d" % PORT)
    if pick_proxy():
        print("已检测到本机代理")
    threading.Thread(target=pw_loop, daemon=True).start()
    threading.Thread(target=beat_loop, daemon=True).start()
    threading.Thread(target=poll_gateway, daemon=True).start()
    Server(("127.0.0.1", PORT), H).serve_forever()
