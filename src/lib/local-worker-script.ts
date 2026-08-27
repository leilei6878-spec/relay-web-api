export const LOCAL_WORKER = "http://127.0.0.1:18765";

export function localWorkerScript() {
  return `#!/usr/bin/env python3
# Relay 本机 ChatGPT Worker。保持窗口开着，平台试运行会连过来。
import json, os, socket, ssl, subprocess, sys, tempfile, threading, time, base64, queue, re
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
            prompt = "\\n".join([t for t in texts if t]).strip() or prompt
    cap = 6 if (body.get("platform") == "leonardo" or is_leonardo_model(body.get("model"))) else 4
    return prompt, images[:cap]

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
            elif url.startswith("http://") or url.startswith("https://"):
                import urllib.request
                path = os.path.join(tempfile.gettempdir(), "relay-img-%s-%d.bin" % (os.getpid(), i))
                try:
                    urllib.request.urlretrieve(url, path)
                    if os.path.getsize(path) > 32:
                        paths.append(path)
                except Exception:
                    continue
        except Exception:
            continue
    return paths

def ref_body_sizes(images):
    out = set()
    for item in images or []:
        url = item if isinstance(item, str) else ((item or {}).get("url") if isinstance(item, dict) else "")
        if not isinstance(url, str) or not url.startswith("data:") or "," not in url:
            continue
        try:
            raw = base64.b64decode(url.split(",", 1)[1])
            if raw:
                out.add(len(raw))
        except Exception:
            pass
    return out

def attach_images(page, images):
    paths = materialize_images(images)
    if not paths:
        return
    try:
        loc = page.locator("input[type=file]")
        if loc.count() > 0:
            loc.first.set_input_files(paths)
            wait_composer_files(page)
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
    wait_composer_files(page)

def wait_composer_files(page, timeout_ms=8000):
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        try:
            if page.locator('form img, [data-testid*="attachment"] img, button[aria-label*="Remove"], button[aria-label*="移除"]').count() > 0:
                return True
        except Exception:
            pass
        time.sleep(0.12)
    return False

def leonardo_refs_attached(page):
    try:
        n = page.evaluate("""() => {
          const remove = [...document.querySelectorAll('button')].filter((b) => {
            const a = (b.getAttribute('aria-label') || '').toLowerCase();
            const t = (b.innerText || '').trim().toLowerCase();
            return /remove|delete|clear reference|remove image/.test(a) || t === '×' || t === 'x';
          });
          const ta = document.querySelector('#home-prompt-textarea, textarea, div[contenteditable="true"]');
          let root = ta ? ta.parentElement : document.body;
          for (let i = 0; i < 6 && root && root !== document.body; i++) root = root.parentElement;
          root = root || document.body;
          const thumbs = [...root.querySelectorAll('img')].filter((im) => {
            const r = im.getBoundingClientRect();
            const w = im.naturalWidth || im.width || r.width || 0;
            const h = im.naturalHeight || im.height || r.height || 0;
            return w >= 24 && w <= 320 && h >= 24 && h <= 320 && r.width >= 24 && r.height >= 24 && r.bottom > 0 && r.top < window.innerHeight;
          });
          return { remove: remove.length, thumbs: thumbs.length };
        }""")
        if int((n or {}).get("remove") or 0) > 0 or int((n or {}).get("thumbs") or 0) > 0:
            return True
    except Exception:
        pass
    return False

def attach_leonardo_refs(page, images):
    seen = []
    for item in images or []:
        if item and item not in seen:
            seen.append(item)
    paths = materialize_images(seen[:6])
    if not paths:
        return "LEONARDO_DOM_CHANGED: cannot read reference images"
    print("leonardo attaching %d refs" % len(paths), flush=True)
    attached = {"ok": False}

    def mark_ok(how):
        attached["ok"] = True
        print("leonardo attach", how, flush=True)
        return True

    def on_chooser(fc):
        try:
            fc.set_files(paths)
            mark_ok("filechooser")
        except Exception as e:
            print("leonardo filechooser fail", str(e)[:100], flush=True)

    try:
        page.on("filechooser", on_chooser)
    except Exception:
        pass

    def try_set_files():
        if attached["ok"]:
            return True
        loc = page.locator("input[type=file]")
        try:
            n = loc.count()
        except Exception:
            n = 0
        print("leonardo file inputs", n, flush=True)
        if n <= 0:
            return False
        for idx in range(n - 1, -1, -1):
            try:
                loc.nth(idx).set_input_files(paths, timeout=3500)
                page.wait_for_timeout(500)
                return mark_ok("set_input_files %d" % idx)
            except Exception as e:
                print("leonardo set fail", idx, str(e).splitlines()[0][:120], flush=True)
        return False

    def js_click(substr):
        try:
            hit = page.evaluate(
                """(s) => {
                  const want = (s || '').toLowerCase();
                  const nodes = [...document.querySelectorAll('button, [role=menuitem], [role=option], [data-slot=dropdown-menu-item], [data-radix-collection-item], [role=button]')];
                  const match = nodes.filter((e) => ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).toLowerCase().includes(want));
                  const vis = match.filter((e) => {
                    const r = e.getBoundingClientRect();
                    const st = getComputedStyle(e);
                    return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < window.innerHeight && st.visibility !== 'hidden' && st.display !== 'none';
                  });
                  const n = vis[vis.length - 1] || match[match.length - 1];
                  if (!n) return '';
                  n.click();
                  const r = n.getBoundingClientRect();
                  return ((n.innerText || '') + '|' + (n.getAttribute('aria-label') || '') + '|vis=' + vis.length + '|box=' + Math.round(r.width) + 'x' + Math.round(r.height)).trim();
                }""",
                substr,
            )
            print("leonardo js-click", substr, hit, flush=True)
            return bool(hit)
        except Exception as e:
            print("leonardo js-click fail", substr, str(e)[:80], flush=True)
            return False

    try:
        try_set_files()
        if wait_leonardo_refs(page, 2500):
            return None
        opened = page.evaluate("""() => {
          const ta = document.querySelector('#home-prompt-textarea, textarea[placeholder*="prompt" i], textarea');
          const isVis = (el) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return r.width > 6 && r.height > 6 && r.bottom > 0 && r.top < window.innerHeight && st.visibility !== 'hidden' && st.display !== 'none';
          };
          const score = (b) => {
            const t = ((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || '')).toLowerCase();
            if (t.includes('add reference to generation')) return 4;
            if (t.includes('add image reference')) return 3;
            if (t.includes('image guidance')) return 3;
            if (t.includes('add reference') || t.includes('add image')) return 2;
            if (t.includes('upload')) return 1;
            return 0;
          };
          const near = [];
          if (ta) {
            let root = ta.parentElement;
            for (let i = 0; i < 8 && root; i++) {
              near.push(...root.querySelectorAll('button'));
              root = root.parentElement;
            }
          }
          const all = [...new Set([...near, ...document.querySelectorAll('button')])];
          const ranked = all.filter(isVis).map((b) => ({b: b, s: score(b)})).filter((x) => x.s > 0).sort((a, c) => c.s - a.s);
          const hit = ranked[0];
          if (!hit) return '';
          hit.b.click();
          const r = hit.b.getBoundingClientRect();
          return ((hit.b.getAttribute('aria-label') || '') + '|' + (hit.b.innerText || '').trim() + '|' + Math.round(r.width) + 'x' + Math.round(r.height));
        }""")
        print("leonardo open ref menu", opened, flush=True)
        page.wait_for_timeout(450)
        js_click("image reference")
        page.wait_for_timeout(400)
        try:
            page.wait_for_selector("input[type=file]", timeout=2500, state="attached")
        except Exception:
            pass
        try_set_files()
        if wait_leonardo_refs(page, 4000):
            return None
        for name in ("Image Guidance", "upload image", "upload", "style reference", "content reference"):
            js_click(name)
            page.wait_for_timeout(300)
            try:
                page.wait_for_selector("input[type=file]", timeout=1200, state="attached")
            except Exception:
                pass
            try_set_files()
            if wait_leonardo_refs(page, 2500):
                return None
        try:
            dump = page.evaluate("""() => [...document.querySelectorAll('button, [role=button], label, input[type=file]')].slice(0, 120).map((e) => ((e.getAttribute('aria-label') || '') + '|' + ((e.innerText || '').trim().slice(0, 36)) + '|' + (e.getAttribute('type') || '') + '|' + e.tagName)).filter((t) => /image|upload|ref|file|add|guid|attach|photo|drop/i.test(t))""")
            print("leonardo upload dump", dump, flush=True)
            page.screenshot(path="/tmp/leo-upload.png", timeout=4000)
        except Exception:
            pass
        if leonardo_refs_attached(page):
            return None
        return "LEONARDO_DOM_CHANGED: reference image did not attach"
    finally:
        try:
            page.remove_listener("filechooser", on_chooser)
        except Exception:
            try:
                page.off("filechooser", on_chooser)
            except Exception:
                pass
        if not leonardo_refs_attached(page):
            try:
                page.keyboard.press("Escape")
            except Exception:
                pass


def leonardo_js_fill(page, prompt):
    try:
        return bool(page.evaluate(
            """(t) => {
              const els = [...document.querySelectorAll('#home-prompt-textarea, textarea, [contenteditable="true"]')];
              const el = els.find((e) => /prompt/i.test(e.getAttribute('placeholder') || '') || e.id === 'home-prompt-textarea') || els[els.length - 1];
              if (!el) return false;
              el.focus();
              if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && desc.set) desc.set.call(el, t);
                else el.value = t;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
              el.textContent = t;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: t, inputType: 'insertText' }));
              return true;
            }""",
            prompt,
        ))
    except Exception as e:
        print("leonardo fill eval", str(e)[:100], flush=True)
        return False


def leonardo_js_generate(page):
    try:
        clicked = page.evaluate("""() => {
          const b = document.querySelector('button[aria-label="Generate"], button[aria-label*="Generate" i]');
          if (b && !b.disabled) { b.click(); return 'aria'; }
          const t = [...document.querySelectorAll('button')].find((e) => /^(generate|create)$/i.test((e.innerText || '').trim()) && !e.disabled);
          if (t) { t.click(); return 'text'; }
          return '';
        }""")
        print("leonardo generate click", clicked, flush=True)
        return bool(clicked)
    except Exception as e:
        print("leonardo generate fail", str(e)[:100], flush=True)
        return False


def wait_leonardo_generate_ready(page, timeout_ms=20000):
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        try:
            ready = page.evaluate("""() => {
              const b = document.querySelector('button[aria-label="Generate"], button[aria-label*="Generate" i]');
              if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') return true;
              const t = [...document.querySelectorAll('button')].find((e) => /^(generate|create)$/i.test((e.innerText || '').trim()));
              return !!(t && !t.disabled && t.getAttribute('aria-disabled') !== 'true');
            }""")
            if ready:
                return True
        except Exception:
            pass
        try:
            page.wait_for_timeout(280)
        except Exception:
            time.sleep(0.28)
    return False


def wait_leonardo_refs(page, timeout_ms=8000):
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        if leonardo_refs_attached(page):
            return True
        try:
            page.wait_for_timeout(250)
        except Exception:
            time.sleep(0.25)
    return leonardo_refs_attached(page)


# Ignore ChatGPT placeholders such as "Analyzing image" so vision waits for the real answer.
PLACEHOLDER_TEXT = re.compile(
    r"^(analyzing( image)?|thinking|working on it|searching|reading|loading|正在(分析|思考|生成|阅读|识别)|分析图片|分析中)[s.。…]*$",
    re.I,
)

def usable_assistant_text(text):
    t = (text or "").strip()
    if not t:
        return False
    if PLACEHOLDER_TEXT.match(t):
        return False
    if t.lower() in ("...", "…", "wait", "done"):
        return False
    return True


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
            composer = page.locator("#home-prompt-textarea, textarea[placeholder*='prompt' i], textarea[placeholder*='Prompt'], textarea[placeholder*='image' i], [data-testid*='prompt'] textarea, div[contenteditable='true']").first.count() > 0
            send = page.locator('button[aria-label="Generate"], button[aria-label*="Generate" i], button:has-text("Generate"), button:has-text("Create")').first.count() > 0
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
        ok = page.evaluate("""() => {
          const form = document.querySelector('form:has(#prompt-textarea), form:has([contenteditable="true"])');
          const b = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]');
          if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
            b.click();
            return 'btn';
          }
          if (form && form.requestSubmit) {
            form.requestSubmit();
            return 'form';
          }
          return '';
        }""")
        if ok:
            return True
    except Exception:
        pass
    try:
        if send_button_enabled(page) and btn:
            btn.click(timeout=1500)
            return True
    except Exception:
        pass
    try:
        page.locator("#prompt-textarea").first.press("Enter")
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
          const b = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]');
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
            const prev = window.__relayPrev || '';
            if (t.startsWith(prev)) d = t.slice(prev.length);
            else {
              let i = 0;
              const n = Math.min(prev.length, t.length);
              while (i < n && prev[i] === t[i]) i++;
              if (i >= Math.max(12, Math.floor(prev.length * 0.5))) d = t.slice(i);
            }
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
        note = ("\\n[attached:%d image(s)]" % len(imgs)) if imgs else ""
        cur = ' current="true"' if i == last_i else ""
        blocks.append("<relay:%s%s>\\n%s%s\\n</relay:%s>" % (role, cur, text, note, role))
    return "\\n\\n".join(blocks).strip()

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
    return route.continue_()

def arm_page(page):
    return

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

def click_named(page, names, timeout=900):
    for name in names:
        try:
            loc = page.get_by_role("button", name=name, exact=False)
            if loc.count() > 0 and loc.first.is_visible():
                loc.first.click(timeout=timeout)
                return True
        except Exception:
            pass
        try:
            loc = page.get_by_text(name, exact=True)
            if loc.count() > 0 and loc.first.is_visible():
                loc.first.click(timeout=timeout)
                return True
        except Exception:
            pass
    return False

def select_model(page, model):
    want_think = "thinking" in (model or "").lower() or model in ("o1", "o3")
    if not want_think:
        if click_named(page, ["Instant", "Fast", "快速响应", "快速"]):
            time.sleep(0.12)
            return True, "Instant"
        switchers = [
            '[data-testid="model-switcher-dropdown-button"]',
            'button:has-text("ChatGPT 5")',
            'button:has-text("GPT-5")',
            'button:has-text("Thinking")',
            'button:has-text("Sol")',
            '[aria-label*="Model"]',
        ]
        for sw in switchers:
            loc = page.locator(sw).first
            try:
                if loc.count() > 0 and loc.is_visible():
                    loc.click(timeout=1200)
                    time.sleep(0.2)
                    if click_named(page, ["Instant", "Fast", "Auto", "GPT-5.6", "快速响应"]):
                        time.sleep(0.12)
                        return True, "Instant"
                    try:
                        page.keyboard.press("Escape")
                    except Exception:
                        pass
                    break
            except Exception:
                continue
        try:
            if page.locator("#prompt-textarea, textarea#prompt-textarea").count() > 0:
                return True, "ChatGPT"
        except Exception:
            pass
        return True, "ChatGPT"
    labels = {
        "gpt-5.6": ["GPT-5.6", "5.6", "Instant", "ChatGPT", "Auto", "GPT-5"],
        "latest": ["GPT-5.6", "GPT-5", "Instant", "ChatGPT", "Auto"],
        "gpt-5": ["GPT-5 Auto", "Auto", "GPT-5", "ChatGPT", "Instant"],
        "gpt-5-thinking": ["GPT-5 Thinking", "Thinking", "Sol"],
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
    if page.locator("#prompt-textarea, textarea#prompt-textarea").count() > 0:
        if not actual:
            actual = "ChatGPT"
        return True, actual
    ok = any(lab.lower() in actual.lower() for lab in labels) if actual else False
    return ok, actual

def run_chat(body):
    from playwright.sync_api import sync_playwright
    prompt, images = extract_prompt_images(body)
    turns = body.get("turns") or []
    user_turns = [t for t in turns if isinstance(t, dict) and str(t.get("role") or "user").lower() == "user"]
    if len(turns) <= 1 and user_turns:
        prompt = (user_turns[0].get("text") or prompt or "").strip()
    elif turns:
        formatted = format_turns(turns)
        if formatted:
            prompt = formatted
    for turn in turns:
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
            if not composer_ready(page, 800):
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
        want_fast = "thinking" not in (model or "").lower()
        has_images = bool(images)
        first_wait = (40 if has_images else 18) if want_fast else min(120, timeout_ms / 1000.0)
        deadline = time.time() + ((75 if has_images else 45) if want_fast else timeout_ms / 1000.0)
        token_deadline = time.time() + first_wait
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
            if usable_assistant_text(full):
                piece = "".join(drained.get("deltas") or [])
                if full != text:
                    last_change = time.time()
                if piece:
                    if not first_delta:
                        first_delta = True
                        mark("T8")
                    post_chunk(piece)
                elif not text:
                    if not first_delta:
                        first_delta = True
                        mark("T8")
                    post_chunk(full)
                text = full
            idle = time.time() - last_change
            if text and not generating and idle >= (0.6 if has_images else 0.35):
                break
            if text and idle >= (2.2 if has_images else 1.2):
                break
            if not first_delta and time.time() > token_deadline:
                break
            time.sleep(0.06)
        mark("T9")
        if not usable_assistant_text(text):
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
        sys.stdout.write("[%s] %s\\n" % (self.log_date_time_string(), msg))

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
            body["platform"] = "leonardo" if is_leonardo_model(model) else "gemini"
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
        if body.get("platform") in ("gemini", "image", "leonardo") or body.get("kind") in ("image", "edit"):
            if body.get("platform") == "leonardo" or is_leonardo_model(body.get("model")):
                return run_leonardo(body)
            return run_image(body)
        return run_chat(body)
    except Exception as e:
        return {"ok": False, "error": "WORKER_CRASH: %s" % str(e)[:240], "fault": "worker"}
    finally:
        ACTIVE -= 1
        account_lock(aid).release()
        SEM.release()
        os.environ["RELAY_JOB_ID"] = ""
        os.environ["RELAY_ACCOUNT_ID"] = ""
        os.environ["RELAY_LEASE_ID"] = ""
        os.environ["RELAY_ATTEMPT_ID"] = ""

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
        apply_gemini_aspect(page, body.get("aspect") or size_to_aspect(body.get("size") or "1:1"))
        baseline = snapshot_image_srcs(page)
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
    raw = str(size or "1024x1024").strip().replace("：", ":").replace("/", ":")
    low = raw.lower().replace("×", "x").replace(" ", "")
    named = {
        "1:1": "1:1", "3:2": "3:2", "2:3": "2:3", "4:3": "4:3", "3:4": "3:4",
        "16:9": "16:9", "9:16": "9:16", "4:5": "4:5", "5:4": "5:4", "21:9": "21:9",
        "square": "1:1", "landscape": "16:9", "widescreen": "16:9", "portrait": "9:16",
    }
    if low in named:
        return named[low]
    native = {
        (1024, 1024): "1:1", (2048, 2048): "1:1", (4096, 4096): "1:1", (2880, 2880): "1:1",
        (1264, 848): "3:2", (2528, 1696): "3:2", (1536, 1024): "3:2",
        (848, 1264): "2:3", (1696, 2528): "2:3", (1024, 1536): "2:3",
        (1376, 768): "16:9", (2752, 1536): "16:9", (5504, 3072): "16:9", (2048, 1152): "16:9", (3840, 2160): "16:9",
        (768, 1376): "9:16", (1536, 2752): "9:16", (3072, 5504): "9:16", (1152, 2048): "9:16", (2160, 3840): "9:16",
        (1200, 896): "4:3", (2400, 1792): "4:3", (896, 1200): "3:4",
        (928, 1152): "4:5", (1856, 2304): "4:5", (1152, 928): "5:4",
        (1584, 672): "21:9", (3168, 1344): "21:9", (6336, 2688): "21:9",
    }
    try:
        parts = low.split("x")
        w, h = int(parts[0]), int(parts[1])
        if (w, h) in native:
            return native[(w, h)]
        r = w / float(h)
    except Exception:
        return "1:1"
    opts = [("1:1", 1.0), ("3:2", 1.5), ("2:3", 2.0/3), ("4:3", 4.0/3), ("3:4", 0.75), ("16:9", 16.0/9), ("9:16", 9.0/16), ("4:5", 0.8), ("5:4", 1.25), ("21:9", 21.0/9)]
    best, dist = "1:1", 99.0
    for lab, ar in opts:
        d = abs(r - ar)
        if d < dist:
            dist, best = d, lab
    return best

NATIVE_1K = {
    "1:1": (1024, 1024), "3:2": (1264, 848), "2:3": (848, 1264),
    "4:3": (1200, 896), "3:4": (896, 1200), "16:9": (1376, 768), "9:16": (768, 1376),
    "4:5": (928, 1152), "5:4": (1152, 928), "21:9": (1584, 672),
}

def parse_size_wh(size):
    raw = str(size or "1024x1024").strip().lower().replace("×", "x").replace(" ", "")
    if raw in ("", "auto"):
        return 1024, 1024
    if raw in ("1k", "small"):
        return 1024, 1024
    if raw in ("2k", "medium"):
        return 2048, 2048
    if raw in ("4k", "large"):
        return 4096, 4096
    if raw in NATIVE_1K:
        return NATIVE_1K[raw]
    try:
        parts = raw.split("x")
        return int(parts[0]), int(parts[1])
    except Exception:
        return 1024, 1024

def size_tier(w, h, gpt):
    m = max(w, h)
    if gpt:
        if m >= 2500:
            return "Large", 2880
        if m >= 1536:
            return "Medium", 2048
        return "Small", 1024
    if m >= 3072:
        return "Large", 4096
    if m >= 1536:
        return "Medium", 2048
    return "Small", 1024

def click_leonardo_aspect(page, aspect):
    aspect = str(aspect or "1:1").strip()
    presets = {
        "16:9": ["Facebook (16:9)", "Desktop (16:9)", "Facebook", "Desktop"],
        "9:16": ["TikTok (9:16)", "Mobile (9:16)", "TikTok", "Mobile"],
        "4:3": ["Twitter (4:3)", "Twitter"],
        "4:5": ["Instagram (4:5)", "Instagram"],
        "1:1": ["Square (1:1)", "Square"],
        "21:9": ["Ultrawide (21:9)", "Ultrawide"],
        "2:3": ["2:3"],
        "3:2": ["3:2"],
        "3:4": ["3:4"],
        "5:4": ["5:4"],
    }.get(aspect, [aspect])
    how = ""
    try:
        how = page.evaluate(
            """(args) => {
              const aspect = String(args.aspect || '1:1');
              const vis = (el) => {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < window.innerHeight && st.visibility !== 'hidden' && st.display !== 'none';
              };
              const nodes = [...document.querySelectorAll('button, [role=button], [role=radio], [role=option], [role=menuitem], [data-radix-collection-item]')];
              const buttons = nodes.filter(vis);
              const linesOf = (el) => ((el.innerText || '').trim().split('\\n').map((s) => s.trim()).filter(Boolean));
              const selected = (el) => el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'on' || el.getAttribute('aria-checked') === 'true';
              const chip = buttons.find((e) => {
                const lines = linesOf(e);
                const t = lines.join(' ');
                if (lines.includes(aspect) && t.length <= aspect.length + 16) return true;
                const a = (e.getAttribute('aria-label') || '').trim();
                return a === aspect || a === ('Aspect ratio: ' + aspect);
              });
              if (chip) {
                if (selected(chip)) return 'chip-already';
                chip.click();
                return 'chip';
              }
              const custom = buttons.find((e) => {
                const lines = linesOf(e);
                const a = (e.getAttribute('aria-label') || '').trim();
                return lines.includes('Custom') || /^custom$/i.test(a);
              });
              if (custom) {
                custom.click();
                return 'custom-open';
              }
              const opener = buttons.find((e) => /^Aspect ratio:/i.test((e.getAttribute('aria-label') || '').trim()));
              if (opener) {
                const cur = (opener.getAttribute('aria-label') || '').replace(/^Aspect ratio:\\s*/i, '').trim();
                if (cur === aspect) return 'already';
                opener.click();
                return 'open-legacy:' + cur;
              }
              return 'none';
            }""",
            {"aspect": aspect},
        )
    except Exception as e:
        how = "err:" + str(e)[:60]
    if str(how).startswith("custom-open") or str(how).startswith("open-legacy") or str(how) == "none":
        try:
            page.wait_for_timeout(400)
        except Exception:
            time.sleep(0.4)
        try:
            picked = page.evaluate(
                """(args) => {
                  const aspect = String(args.aspect || '1:1');
                  const presets = args.presets || [];
                  const vis = (el) => {
                    const r = el.getBoundingClientRect();
                    const st = getComputedStyle(el);
                    return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none';
                  };
                  const nodes = [...document.querySelectorAll('button, [role=button], [role=radio], [role=option], [role=menuitem], [data-radix-collection-item], [data-slot=dropdown-menu-item]')].filter(vis);
                  const hit = nodes.find((e) => {
                    const t = ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').trim();
                    if (t === aspect || t.indexOf('(' + aspect + ')') >= 0) return true;
                    return presets.some((p) => t === p || t.indexOf(p) >= 0);
                  });
                  if (!hit) return 'miss';
                  hit.click();
                  return 'preset:' + ((hit.innerText || '').trim().split('\\n')[0]);
                }""",
                {"aspect": aspect, "presets": presets},
            )
        except Exception:
            picked = "err"
        how = str(how) + "+" + str(picked)
        if str(picked).startswith("miss") or str(picked) == "err":
            for name in [aspect] + list(presets):
                try:
                    loc = page.get_by_text(name, exact=True)
                    if loc.count() > 0:
                        loc.first.click(timeout=900, force=True)
                        how = str(how) + "+pw:" + name
                        break
                except Exception:
                    continue
    return how

def click_leonardo_resolution(page, aspect, tier, k, w, h):
    try:
        dim = page.evaluate(
            """(args) => {
              const aspect = String(args.aspect || '1:1');
              const tier = String(args.tier || 'Small');
              const k = String(args.k || '1K');
              const wantX = String(args.w) + 'x' + String(args.h);
              const vis = (el) => {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < window.innerHeight && st.visibility !== 'hidden' && st.display !== 'none';
              };
              const click = (el) => { if (!el) return false; try { el.click(); return true; } catch (e) { return false; } };
              const norm = (s) => String(s || '').replace(/\\s/g, '').replace(/\\u00d7/g, 'x').toLowerCase();
              const buttons = [...document.querySelectorAll('button, [role=button], [role=radio], [role=option]')].filter(vis);
              const squarePreset = (t) => /^(1024x1024|2048x2048|4096x4096|2880x2880)$/.test(t);
              const want = norm(wantX);
              const px = buttons.find((e) => {
                const t = norm(e.innerText || '');
                const a = norm(e.getAttribute('aria-label') || '');
                const first = norm((e.innerText || '').split('\\n')[0]);
                if (aspect !== '1:1' && (squarePreset(first) || squarePreset(t))) return false;
                return t.indexOf(want) >= 0 || a.indexOf(want) >= 0;
              });
              if (click(px)) return 'px';
              const tbtn = buttons.find((b) => {
                const raw = (b.innerText || '').trim();
                const first = raw.split('\\n')[0].trim();
                const t = norm(raw);
                if (!(first === tier || first.toLowerCase() === tier.toLowerCase() || first.toUpperCase() === k)) return false;
                if (aspect !== '1:1' && (squarePreset(t) || t.indexOf('1024x1024') >= 0 || t.indexOf('2048x2048') >= 0)) return false;
                if (/\\d{3,5}x\\d{3,5}/.test(t) && t.indexOf(want) < 0) return false;
                return true;
              });
              if (click(tbtn)) return 'tier';
              return aspect === '1:1' ? 'skip' : 'skip-square';
            }""",
            {"aspect": aspect, "tier": tier, "k": k, "w": w, "h": h},
        )
    except Exception:
        dim = "err"
    return dim

def read_displayed_size(page):
    try:
        pair = page.evaluate("""() => {
          const lab = [...document.querySelectorAll('div,p,span,label,h2,h3,h4')].find((e) => {
            const t = (e.innerText || '').split('\\n')[0] || '';
            return /image dimensions/i.test(t) && t.length < 80;
          });
          const root = lab ? (lab.parentElement || lab) : document.body;
          const blob = ((root && root.innerText) || '').replace(/\\u00d7/g, 'x');
          const m = blob.match(/(\\d{3,5})\\s*x\\s*(\\d{3,5})/);
          if (m) return [Number(m[1]), Number(m[2])];
          return [0, 0];
        }""")
        if pair and len(pair) == 2:
            return int(pair[0] or 0), int(pair[1] or 0)
    except Exception:
        pass
    return 0, 0

def apply_image_size(page, want_size, aspect=None, tier=None, gpt=False):
    aspect = (aspect or size_to_aspect(want_size) or "1:1").strip()
    w, h = parse_size_wh(want_size)
    if not tier:
        tier, _px = size_tier(w, h, gpt)
    k = "4K" if str(tier).lower() == "large" else ("2K" if str(tier).lower() == "medium" else "1K")
    opened = click_leonardo_aspect(page, aspect)
    try:
        page.keyboard.press("Escape")
    except Exception:
        pass
    try:
        page.wait_for_timeout(400)
    except Exception:
        time.sleep(0.4)
    dim = click_leonardo_resolution(page, aspect, tier, k, w, h)
    shown_w, shown_h = read_displayed_size(page)
    print("image size want=%s aspect=%s tier=%s %dx%d open=%s dim=%s shown=%dx%d" % (want_size, aspect, tier, w, h, opened, dim, shown_w, shown_h), flush=True)
    try:
        page.keyboard.press("Escape")
    except Exception:
        pass
    return w, h, aspect, tier

def apply_gemini_aspect(page, aspect):
    aspect = (aspect or "1:1").strip()
    try:
        page.evaluate(
            """(aspect) => {
              const vis = (el) => {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none';
              };
              const nodes = [...document.querySelectorAll('button, [role=button], [role=radio], [role=option], [role=menuitem]')];
              let hit = nodes.find((e) => vis(e) && ((e.innerText || '').trim().split('\\n')[0] === aspect || (e.getAttribute('aria-label') || '').trim() === aspect));
              if (hit) { hit.click(); return; }
              const opener = nodes.find((e) => vis(e) && /aspect/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '')));
              if (opener) opener.click();
            }""",
            aspect,
        )
        page.wait_for_timeout(280)
        page.evaluate(
            """(aspect) => {
              const nodes = [...document.querySelectorAll('button, [role=button], [role=radio], [role=option], [role=menuitem]')];
              const hit = nodes.find((e) => ((e.innerText || '').trim().split('\\n')[0] === aspect) || ((e.getAttribute('aria-label') || '').indexOf(aspect) >= 0));
              if (hit) hit.click();
            }""",
            aspect,
        )
    except Exception:
        pass

def aspect_match(w, h, aspect, slack=0.12):
    try:
        aw, ah = [float(x) for x in str(aspect).split(":")]
        if w < 16 or h < 16 or ah == 0:
            return False
        return abs((w / float(h)) - (aw / ah)) <= slack
    except Exception:
        return True

def is_leonardo_model(model):
    m = str(model or "").lower()
    if m == "gemini-image":
        return False
    return (
        m.startswith("leonardo-")
        or "gpt-image" in m
        or m.startswith("dall-e")
        or "nano-banana" in m
        or "flash-image" in m
        or "pro-image" in m
        or "lite-image" in m
        or "gemini-image-" in m
        or m.startswith("imagen")
    )

def is_gpt_image_model(model):
    m = str(model or "").lower()
    return "gpt-image" in m or m.startswith("dall-e") or m == "leonardo-gpt-image-2"

def image_wh(raw):
    if not raw or len(raw) < 24:
        return 0, 0
    try:
        if raw[:8] == b"\\x89PNG\\r\\n\\x1a\\n":
            import struct
            return struct.unpack(">II", raw[16:24])
        if raw[:2] == b"\\xff\\xd8":
            i = 2
            while i + 9 < len(raw):
                if raw[i] != 0xff:
                    i += 1
                    continue
                marker = raw[i + 1]
                if marker in (0xc0, 0xc1, 0xc2):
                    h = (raw[i + 5] << 8) | raw[i + 6]
                    w = (raw[i + 7] << 8) | raw[i + 8]
                    return w, h
                ln = (raw[i + 2] << 8) | raw[i + 3]
                if ln < 2:
                    break
                i += 2 + ln
    except Exception:
        return 0, 0
    return 0, 0

def upgrade_cdn_url(url):
    u = str(url or "")
    if not u.startswith("http"):
        return u
    u = re.sub(r"([?&])(w|width|h|height|dpr|q|quality|fm|fit)=[^&]*", r"\\1", u)
    u = re.sub(r"[?&]$", "", u)
    u = re.sub(r"/(256|384|512|640|768)(/|$)", r"/", u)
    u = re.sub(r"_(256|384|512|640|768)(\\.[a-zA-Z]+)$", r"\\2", u)
    return u

def raw_to_data_url(raw, mime="image/jpeg"):
    if not raw:
        return None
    mt = (mime or "image/jpeg").split(";")[0]
    if "png" in mt:
        mt = "image/png"
    elif "webp" in mt:
        mt = "image/webp"
    else:
        mt = "image/jpeg"
    return "data:%s;base64,%s" % (mt, base64.b64encode(raw).decode())

def download_result_image(context, url):
    if not url:
        return None, "LEONARDO_RESULT_NOT_FOUND"
    if url.startswith("data:image/svg"):
        return None, "LEONARDO_RESULT_NOT_FOUND: svg rejected"
    if url.startswith("data:image"):
        return url, None
    if url.startswith("http"):
        last_err = "LEONARDO_DOWNLOAD_FAILED"
        for candidate in (url, upgrade_cdn_url(url)):
            if not candidate:
                continue
            try:
                resp = context.request.get(candidate, timeout=20000)
                raw = resp.body()
                mime = (resp.headers.get("content-type") or "image/png").split(";")[0]
                if "svg" in mime:
                    last_err = "LEONARDO_RESULT_NOT_FOUND: svg rejected"
                    continue
                if not raw or len(raw) < 2048:
                    last_err = "LEONARDO_RESULT_NOT_FOUND: image too small"
                    continue
                return "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode()), None
            except Exception:
                last_err = "LEONARDO_DOWNLOAD_FAILED"
        return None, last_err
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
    gpt = is_gpt_image_model(model)
    labels = ["GPT Image 2", "GPT Image", "gpt-image-2"] if gpt else ["Nano Banana 2", "Nano Banana", "Gemini Image 2", "Gemini 2.5 Flash Image", "gemini-image-2", "Gemini 2.5"]
    proxy = job_proxy(body)
    if not proxy:
        return {"ok": False, "error": "LEONARDO_PROXY_UNAVAILABLE: job missing account-bound proxy", "fault": "proxy", "backendMode": "web_account"}
    if not socks_https_ok(proxy):
        return {"ok": False, "error": tunnel_down_error(), "fault": "proxy", "backendMode": "web_account"}
    target = os.environ.get("LEONARDO_URL") or "https://app.leonardo.ai/ai-creation"
    home = "https://app.leonardo.ai/"
    prompt_sel = "#home-prompt-textarea, textarea[placeholder*='prompt' i], textarea[placeholder*='Prompt'], textarea[placeholder*='image' i], [data-testid*='prompt'] textarea, div[contenteditable='true']"
    gen_sel = 'button[aria-label="Generate"], button[aria-label*="Generate" i], button:has-text("Generate"), button:has-text("Create")'
    want_n = int(body.get("n") or 1)
    want_size = body.get("size") or "1024x1024"
    want_quality = str(body.get("quality") or "MEDIUM").upper()
    kind = body.get("kind") or "image"
    pack_version = body.get("selectorPackVersion") or "leonardo-image-v1"

    SKIP_MODEL = set("auto small medium large dynamic custom low high style model quality enhance private reset defaults prompt 1:1 2:3 3:2 16:9 9:16 4:3 4:5 21:9".split())

    def selected_model_label(page):
        try:
            raw = page.evaluate("""() => {
              const buttons = [...document.querySelectorAll('button, [role=button]')];
              const n = buttons.find((e) => {
                const a = (e.getAttribute('aria-label') || '').trim().toLowerCase();
                const t = (e.innerText || '').trim().toLowerCase();
                return a === 'model' || t.indexOf('model') === 0;
              });
              return n ? (n.innerText || '') : '';
            }""") or ""
        except Exception:
            raw = ""
        lines = [ln.strip() for ln in str(raw).replace("\\r", "").split("\\n") if ln.strip()]
        for ln in lines:
            low = ln.lower()
            if low in SKIP_MODEL or len(ln) < 4:
                continue
            return ln
        return ""

    def open_and_list_models(page):
        names = []
        for spec in ('button:has-text("Model")', '[aria-label="Model"]', '[aria-label^=Model]', 'button:has-text("Auto")'):
            try:
                loc = page.locator(spec).first
                if loc.count() == 0:
                    continue
                loc.click(timeout=1400, force=True)
                page.wait_for_timeout(700)
            except Exception:
                continue
            try:
                texts = page.evaluate("""() => [...document.querySelectorAll('[role=menuitem], [role=option], [data-slot=dropdown-menu-item], [data-radix-collection-item], li, button')].map(e => (e.innerText||'').trim()).filter(t => t && t.length >= 4 && t.length < 80)""")
            except Exception:
                texts = []
            if isinstance(texts, list):
                for t in texts:
                    line = [ln.strip() for ln in str(t).split("\\n") if ln.strip()]
                    label = line[-1] if line else str(t).strip()
                    if not label or label.lower() in SKIP_MODEL:
                        continue
                    if not re.search(r"nano|banana|gemini|gpt image|flux|lucid|phoenix|kino|seedream|imagen|ideogram|preset", label, re.I):
                        continue
                    if label not in names:
                        names.append(label)
            if names:
                break
        return names

    def enum_model_labels(page):
        found = []
        current = selected_model_label(page)
        if current:
            found.append(current)
        for n in open_and_list_models(page):
            if n not in found:
                found.append(n)
        return found

    def pick_model_label(available, labels):
        best, score = "", -1
        labs = [str(x).strip() for x in (labels or []) if x]
        for item in available or []:
            il = str(item).strip()
            if len(il) < 4:
                continue
            low = il.lower()
            if low in SKIP_MODEL:
                continue
            sc = 0
            for lab in labs:
                ll = lab.lower()
                if low == ll:
                    sc = max(sc, 200 + len(ll))
                elif ll in low and len(ll) >= 8:
                    sc = max(sc, 120 + len(ll))
                elif low in ll and len(low) >= 8:
                    sc = max(sc, 80 + len(low))
            if sc > score:
                score, best = sc, il
        return best if score > 0 else ""

    def page_text(page, n=8000):
        try:
            return (page.locator("body").inner_text() or "")[:n]
        except Exception:
            return ""

    def is_ai_creation(page):
        u = (page.url or "").lower()
        if "/generate" in u or "ai-creation" in u:
            return True
        low = page_text(page, 5000).lower()
        return any(s in low for s in ("nano banana", "gpt image 2", "number of generations", "image dimensions", "ai creation"))

    def click_named(page, name, exact=False):
        for getter in (
            lambda: page.get_by_role("link", name=name, exact=exact),
            lambda: page.get_by_role("button", name=name, exact=exact),
            lambda: page.get_by_text(name, exact=exact),
        ):
            try:
                loc = getter()
                if loc.count() > 0:
                    loc.first.click(timeout=1600)
                    return True
            except Exception:
                continue
        return False

    def goto_ai_creation(page):
        if is_ai_creation(page):
            print("leonardo already on generator", page.url, flush=True)
            return True
        urls = [
            "https://app.leonardo.ai/generate?model=auto-preset",
            "https://app.leonardo.ai/generate",
            target,
            "https://app.leonardo.ai/ai-creation",
            "https://app.leonardo.ai/image-generation",
            "https://app.leonardo.ai/create",
        ]
        seen = set()
        for u in urls:
            if u in seen:
                continue
            seen.add(u)
            try:
                page.goto(u, wait_until="domcontentloaded", timeout=25000)
            except Exception:
                pass
            page.wait_for_timeout(900)
            print("leonardo nav", page.url, "ai=", is_ai_creation(page), flush=True)
            if is_ai_creation(page):
                return True
            for name, exact in (("AI Creation", False), ("Image generation", False), ("Generate an image", False), ("Image", True)):
                if click_named(page, name, exact=exact):
                    page.wait_for_timeout(1100)
                    if is_ai_creation(page):
                        return True
        return is_ai_creation(page)

    def run_on(page, context):
        t0 = time.time()
        arm_page(page)
        try:
            page.set_default_timeout(4000)
        except Exception:
            pass
        goto_ai_creation(page)
        pst = detect_page_state(page, "leonardo")
        if pst in ("LOGIN_REQUIRED", "CHALLENGE", "TOKEN_EXHAUSTED", "QUEUE_FULL", "RATE_LIMITED", "ACCOUNT_RESTRICTED"):
            err, fault = page_state_error(pst, False, "leonardo")
            return {"ok": False, "error": err, "fault": fault, "pageState": pst, "backendMode": "web_account", "selectorPackVersion": pack_version}
        if not is_ai_creation(page):
            try:
                page.screenshot(path="/tmp/leo-page.png", timeout=5000)
                open("/tmp/leo-dom.txt","w",encoding="utf-8").write(page_text(page))
            except Exception:
                pass
            err, fault = page_state_error(pst or "DOM_UNKNOWN", True, "leonardo")
            return {"ok": False, "error": err + " url=" + (page.url or "") + " (not AI Creation)", "fault": fault, "pageState": pst, "backendMode": "web_account"}
        box = page.locator(prompt_sel).first
        gen = page.locator(gen_sel).first
        for _ in range(10):
            box = page.locator(prompt_sel).first
            gen = page.locator(gen_sel).first
            if box.count() > 0 and gen.count() > 0:
                break
            page.wait_for_timeout(400)
        if box.count() == 0 or gen.count() == 0:
            err, fault = page_state_error(pst or "DOM_UNKNOWN", True, "leonardo")
            return {"ok": False, "error": err + " url=" + (page.url or ""), "fault": fault, "pageState": pst, "backendMode": "web_account"}
        available = enum_model_labels(page)
        try:
            blob = (page.locator("body").inner_text() or "")[:8000]
        except Exception:
            blob = ""
        for lab in labels:
            if lab.lower() in blob.lower() and lab not in available:
                available.append(lab)
        shown = selected_model_label(page)
        if shown and shown not in available:
            available = [shown] + available
        picked = pick_model_label(available, labels)
        print("leonardo url=%s pst=%s available=%s shown=%s picked=%s" % (page.url, pst, available, shown, picked), flush=True)
        if not picked:
            try:
                page.screenshot(path="/tmp/leo-page.png", timeout=5000)
                open("/tmp/leo-dom.txt","w",encoding="utf-8").write(blob)
            except Exception:
                pass
            return {"ok": False, "error": "LEONARDO_MODEL_UNAVAILABLE: " + model + " url=" + (page.url or ""), "fault": "account", "pageState": "MODEL_UNAVAILABLE", "backendMode": "web_account", "availableModels": available, "modelActual": shown or ""}
        try:
            page.get_by_text(picked, exact=False).first.click(timeout=1500, force=True)
        except Exception:
            page.evaluate("(t) => { const n=[...document.querySelectorAll('[role=menuitem],[role=option],[data-slot=dropdown-menu-item],button')].find(e => (e.innerText||'').includes(t) && (e.innerText||'').trim().length >= 8); if(n) n.click(); }", picked)
        page.wait_for_timeout(400)
        shown2 = selected_model_label(page)
        if shown2 and pick_model_label([shown2], labels):
            picked = shown2
        print("leonardo picked=%s shown=%s" % (picked, shown2), flush=True)
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
        aspect = body.get("aspect") or size_to_aspect(want_size)
        want_w, want_h = parse_size_wh(want_size)
        tier, px = size_tier(want_w, want_h, gpt)
        if body.get("tier"):
            tier = str(body.get("tier"))
        want_min = int(max(want_w, want_h) * 0.72)
        apply_image_size(page, want_size, aspect, tier, gpt)
        shown_w, shown_h = read_displayed_size(page)
        if shown_w and shown_h and not aspect_match(shown_w, shown_h, aspect):
            apply_image_size(page, want_size, aspect, tier, gpt)
            shown_w, shown_h = read_displayed_size(page)
        print("leonardo size want=%s aspect=%s tier=%s %dx%d min=%d shown=%dx%d" % (want_size, aspect, tier, want_w, want_h, want_min, shown_w, shown_h), flush=True)
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
            try:
                page.evaluate(
                    """(n) => {
                      const nodes = [...document.querySelectorAll('div,p,span,label,h2,h3')];
                      const lab = nodes.find((e) => /number of generations/i.test((e.innerText || '').split('\\n')[0] || '') && (e.innerText || '').length < 80);
                      const root = lab ? (lab.parentElement || document.body) : document.body;
                      const btn = [...root.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === String(n));
                      if (btn) btn.click();
                    }""",
                    want_n,
                )
            except Exception:
                pass
        ref_sizes = ref_body_sizes(images)
        if images:
            print("leonardo filling prompt before refs", flush=True)
            leonardo_js_fill(page, prompt)
            up_err = attach_leonardo_refs(page, images)
            if up_err:
                return {"ok": False, "error": up_err + " url=" + (page.url or ""), "fault": "provider", "backendMode": "web_account", "availableModels": available, "modelActual": picked}
            thumbs = wait_leonardo_refs(page, 10000)
            print("leonardo refs attached thumbs=%s sizes=%s" % (thumbs, sorted(ref_sizes)[:6]), flush=True)
            if not thumbs:
                return {"ok": False, "error": "LEONARDO_DOM_CHANGED: reference image did not attach url=" + (page.url or ""), "fault": "provider", "backendMode": "web_account", "availableModels": available, "modelActual": picked}
            filled = leonardo_js_fill(page, prompt)
            print("leonardo fill js", filled, flush=True)
            if not filled:
                return {"ok": False, "error": "LEONARDO_DOM_CHANGED: cannot fill prompt", "fault": "provider", "backendMode": "web_account"}
            apply_image_size(page, want_size, aspect, tier, gpt)
            shown_w, shown_h = read_displayed_size(page)
            if shown_w and shown_h and not aspect_match(shown_w, shown_h, aspect):
                apply_image_size(page, want_size, aspect, tier, gpt)
                shown_w, shown_h = read_displayed_size(page)
            if shown_w and shown_h and not aspect_match(shown_w, shown_h, aspect):
                return {"ok": False, "error": "LEONARDO_DOM_CHANGED: Image Dimensions stayed %dx%d, want %s %s" % (shown_w, shown_h, aspect, want_size), "fault": "provider", "backendMode": "web_account", "availableModels": available, "modelActual": picked}
            ready_gen = wait_leonardo_generate_ready(page, 20000)
            print("leonardo generate ready", ready_gen, flush=True)
            if not ready_gen:
                return {"ok": False, "error": "LEONARDO_GENERATION_FAILED: generate did not become ready after refs", "fault": "provider", "backendMode": "web_account", "availableModels": available, "modelActual": picked, "pageState": "GENERATION_FAILED"}
        elif not fill_composer(page, box, prompt):
            try:
                box.fill(prompt, timeout=1000)
            except Exception:
                return {"ok": False, "error": "LEONARDO_DOM_CHANGED: cannot fill prompt", "fault": "provider", "backendMode": "web_account"}
        try:
            page.wait_for_timeout(400)
        except Exception:
            time.sleep(0.4)
        shown_w, shown_h = read_displayed_size(page)
        if shown_w and shown_h and not aspect_match(shown_w, shown_h, aspect):
            apply_image_size(page, want_size, aspect, tier, gpt)
            shown_w, shown_h = read_displayed_size(page)
        if shown_w and shown_h and not aspect_match(shown_w, shown_h, aspect):
            return {"ok": False, "error": "LEONARDO_DOM_CHANGED: Image Dimensions stayed %dx%d, want %s %s" % (shown_w, shown_h, aspect, want_size), "fault": "provider", "backendMode": "web_account", "availableModels": available, "modelActual": picked}
        baseline = snapshot_image_srcs(page)
        captures = []
        def on_resp(resp):
            try:
                ct = (resp.headers.get("content-type") or "").lower()
                url = resp.url or ""
                if "image/" not in ct or "svg" in ct:
                    return
                if any(b in url.lower() for b in ("favicon", "sprite", "logo", "icon", "emoji", "avatar")):
                    return
                raw = resp.body()
                if not raw or len(raw) < 4096:
                    return
                if len(raw) in ref_sizes:
                    return
                w, h = image_wh(raw)
                captures.append((len(raw), w, h, url, raw, ct.split(";")[0]))
            except Exception:
                pass
        try:
            page.on("response", on_resp)
        except Exception:
            pass
        print("leonardo clicking generate", flush=True)
        gen_clicked = leonardo_js_generate(page)
        if not gen_clicked:
            if images:
                try:
                    page.keyboard.press("Enter")
                except Exception:
                    pass
            else:
                try:
                    gen.click(timeout=1500, force=True)
                    gen_clicked = True
                except Exception:
                    page.keyboard.press("Enter")
        page.wait_for_timeout(800)
        pst2 = detect_page_state(page, "leonardo")
        if pst2 in ("LOGIN_REQUIRED", "TOKEN_EXHAUSTED", "QUEUE_FULL", "CHALLENGE"):
            err, fault = page_state_error(pst2, False, "leonardo")
            return {"ok": False, "error": err, "fault": fault, "pageState": pst2, "backendMode": "web_account", "availableModels": available}
        deadline = time.time() + int(body.get("timeoutMs") or 120000) / 1000
        fail_at = time.time() + 28
        done_hint = ("that's a wrap", "how was this output", "time to generate more")
        progress_hint = ("generating", "queued", "in progress", "creating image", "working on")
        best = []
        saw_progress = False
        while time.time() < deadline:
            html2 = ""
            try:
                html2 = (page.content() or "")[:8000]
            except Exception:
                html2 = ""
            low = html2.lower()
            if "out of tokens" in low or "insufficient tokens" in low:
                return {"ok": False, "error": "LEONARDO_TOKEN_EXHAUSTED", "fault": "account", "pageState": "TOKEN_EXHAUSTED", "backendMode": "web_account", "tokenState": "TOKEN_EXHAUSTED", "availableModels": available}
            if any(h in low for h in progress_hint) or captures:
                saw_progress = True
            try:
                busy = page.evaluate("""() => {
                  const b = document.querySelector('button[aria-label="Generate"], button[aria-label*="Generate" i]');
                  if (b && (b.disabled || b.getAttribute('aria-disabled') === 'true')) return true;
                  return !!(document.querySelector('[role=progressbar], [data-loading="true"]'));
                }""")
                if busy:
                    saw_progress = True
            except Exception:
                pass
            for src in snapshot_image_srcs(page):
                if src in baseline:
                    continue
                saw_progress = True
                if not accept_result_image(src, baseline, None):
                    continue
                data_url, _derr = download_result_image(context, src)
                if not data_url:
                    continue
                try:
                    raw = base64.b64decode(data_url.split(",", 1)[-1])
                except Exception:
                    continue
                if len(raw) in ref_sizes:
                    continue
                w, h = image_wh(raw)
                captures.append((len(raw), w, h, src, raw, "image/jpeg"))
            if images and not saw_progress and time.time() > fail_at:
                return {"ok": False, "error": "LEONARDO_GENERATION_FAILED: generate did not start (img2img)", "fault": "provider", "pageState": "GENERATION_FAILED", "backendMode": "web_account", "availableModels": available, "modelActual": picked}
            ranked = sorted(captures, key=lambda row: (1 if aspect_match(row[1], row[2], aspect) else 0, row[1] * row[2], row[0]), reverse=True)
            picked_rows = []
            seen = set()
            for row in ranked:
                key = (row[1], row[2], row[0])
                if key in seen:
                    continue
                seen.add(key)
                picked_rows.append(row)
                if len(picked_rows) >= max(1, want_n):
                    break
            ready = any(h in low for h in done_hint)
            shaped = [row for row in picked_rows if aspect_match(row[1], row[2], aspect)]
            strong = [row for row in shaped if max(row[1], row[2]) >= want_min]
            if strong and (ready or len(strong) >= max(1, want_n)):
                best = strong[: max(1, want_n)]
                break
            if shaped and ready and time.time() + 8 > deadline:
                best = shaped[: max(1, want_n)]
                break
            time.sleep(0.45)
        if not best and captures:
            ranked = sorted(captures, key=lambda row: (1 if aspect_match(row[1], row[2], aspect) else 0, row[1] * row[2], row[0]), reverse=True)
            shaped = [row for row in ranked if aspect_match(row[1], row[2], aspect)]
            if not shaped:
                got = "%dx%d" % (ranked[0][1], ranked[0][2]) if ranked else "none"
                return {"ok": False, "error": "LEONARDO_RESULT_ASPECT_MISMATCH: want %s got %s" % (aspect, got), "fault": "provider", "pageState": "GENERATION_FAILED", "backendMode": "web_account", "availableModels": available, "modelActual": picked}
            best = shaped[: max(1, want_n)]
        if best and max(best[0][1], best[0][2]) < want_min:
            try:
                page.get_by_text("Download", exact=False).first.click(timeout=1500)
                page.wait_for_timeout(2500)
            except Exception:
                pass
            if captures:
                ranked = sorted([row for row in captures if aspect_match(row[1], row[2], aspect)], key=lambda row: (row[1] * row[2], row[0]), reverse=True)
                if ranked and max(ranked[0][1], ranked[0][2]) >= max(best[0][1], best[0][2]):
                    best = ranked[: max(1, want_n)]
        if not best:
            return {"ok": False, "error": "LEONARDO_RESULT_NOT_FOUND", "fault": "provider", "pageState": "GENERATION_FAILED", "backendMode": "web_account", "availableModels": available, "modelActual": picked}
        data_urls = []
        for row in best:
            du = raw_to_data_url(row[4], row[5])
            if du:
                data_urls.append(du)
        if not data_urls:
            return {"ok": False, "error": "LEONARDO_DOWNLOAD_FAILED", "fault": "provider", "backendMode": "web_account", "availableModels": available}
        print("leonardo result %dx%d bytes=%d n=%d want=%s min=%d" % (best[0][1], best[0][2], best[0][0], len(data_urls), want_size, want_min), flush=True)
        try:
            state_out = context.storage_state()
        except Exception:
            state_out = None
        return {
            "ok": True,
            "url": data_urls[0],
            "urls": data_urls,
            "width": best[0][1],
            "height": best[0][2],
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
                payload["size"] = job.get("size") or "1024x1024"
                payload["aspect"] = job.get("aspect") or ""
                payload["tier"] = job.get("tier") or ""
            elif job.get("platform") == "leonardo":
                payload["platform"] = "leonardo"
                payload["model"] = job.get("model") or "leonardo-gemini"
                payload["n"] = job.get("n") or 1
                payload["size"] = job.get("size") or "1024x1024"
                payload["quality"] = job.get("quality") or "MEDIUM"
                payload["aspect"] = job.get("aspect") or ""
                payload["tier"] = job.get("tier") or ""
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
`;
}
