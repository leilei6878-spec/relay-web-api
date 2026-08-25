export const LOCAL_WORKER = "http://127.0.0.1:18765";

export function localWorkerScript() {
  return `#!/usr/bin/env python3
# Relay 本机 ChatGPT Worker。保持窗口开着，平台试运行会连过来。
import json, os, socket, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("RELAY_WORKER_PORT") or "18765")
STATE = os.path.join(HERE, "state.json")
HEADLESS = os.environ.get("RELAY_HEADLESS") == "1"
TEST_URL = os.environ.get("RELAY_TEST_URL") or ""
CHAT_URL = os.environ.get("RELAY_CHAT_URL") or TEST_URL or "https://chatgpt.com/"
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
    if port_open(10808):
        return {"server": "socks5://127.0.0.1:10808"}
    if port_open(10809):
        return {"server": "http://127.0.0.1:10809"}
    return None

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

def run_chat(body):
    from playwright.sync_api import sync_playwright
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "没有要发送的内容"}
    if TEST_URL:
        return {"ok": True, "text": "MOCK:" + prompt}
    state = body.get("storageState")
    if not state:
        if not os.path.isfile(STATE):
            return {"ok": False, "error": "没有登录态。把 state.json 放到本目录，或从平台下发 Session"}
        with open(STATE, "r", encoding="utf-8") as f:
            state = json.load(f)
    sel = body.get("selectors") or {}
    inp = sel.get("input") or ["#prompt-textarea", "textarea#prompt-textarea"]
    send = sel.get("send") or ["button[data-testid='send-button']", "button[aria-label='Send prompt']"]
    assistant = sel.get("assistant") or ["div[data-message-author-role='assistant']"]
    stop = sel.get("streamingStop") or ["button[aria-label='Stop streaming']", "button[data-testid='stop-button']"]
    timeout_ms = int(body.get("timeoutMs") or 90000)
    proxy = None if TEST_URL else pick_proxy()
    if not proxy and not TEST_URL:
        return {"ok": False, "error": "未检测到 v2rayN。请先打开并选中平台同一条节点（SOCKS 10808）"}

    def first_visible(page, names):
        for s in names:
            loc = page.locator(s).first
            try:
                if loc.count() > 0 and loc.is_visible():
                    return loc
            except Exception:
                pass
        return None

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
            page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=45000)
            time.sleep(0.4 if TEST_URL else 1.2)
            box = first_visible(page, inp)
            if box is None:
                return {"ok": False, "error": "Session 失效或停在登录页，请重新登录"}
            before = page.locator(",".join(assistant)).count()
            box.click()
            box.fill(prompt)
            btn = first_visible(page, send)
            if btn:
                btn.click()
            else:
                page.keyboard.press("Enter")
            stop_sel = ",".join(stop)
            stop_wait = 1500 if TEST_URL else 20000
            try:
                page.locator(stop_sel).first.wait_for(state="visible", timeout=stop_wait)
            except Exception:
                pass
            try:
                page.locator(stop_sel).first.wait_for(state="hidden", timeout=3000 if TEST_URL else max(3000, timeout_ms))
            except Exception:
                pass
            deadline = time.time() + timeout_ms / 1000
            text = ""
            while time.time() < deadline:
                nodes = page.locator(",".join(assistant))
                n = nodes.count()
                if n > before:
                    text = (nodes.nth(n - 1).inner_text() or "").strip()
                    if text:
                        break
                time.sleep(0.4)
            if not text:
                return {"ok": False, "error": "等待回复超时或回复为空"}
            try:
                context.storage_state(path=STATE)
            except Exception:
                pass
            return {"ok": True, "text": text}
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
        if self.path.startswith("/health"):
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            proxy = pick_proxy()
            self.wfile.write(json.dumps({"ok": True, "proxy": bool(proxy)}).encode("utf-8"))
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path not in ("/chat", "/v1/chat/completions"):
            self.send_response(404)
            self.end_headers()
            return
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8") if n else "{}"
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        if "messages" in body and not body.get("prompt"):
            msgs = body.get("messages") or []
            body["prompt"] = msgs[-1].get("content") if msgs else ""
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
    job = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    json.dump(body, job)
    job.close()
    env = os.environ.copy()
    env["RELAY_CHAT_URL"] = CHAT_URL if CHAT_URL.startswith("http") else env.get("RELAY_CHAT_URL", "https://chatgpt.com/")
    timeout_s = max(30, int(body.get("timeoutMs") or 90000) / 1000 + 20)
    try:
        out = subprocess.check_output(
            [sys.executable, os.path.abspath(__file__), "--job", job.name],
            stderr=subprocess.STDOUT,
            timeout=timeout_s,
            env=env,
        )
        line = out.decode("utf-8").strip().splitlines()[-1]
        return json.loads(line)
    except subprocess.CalledProcessError as e:
        err = (e.output or b"").decode("utf-8", "replace")[-400:]
        return {"ok": False, "error": err or str(e)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:400]}

def make_image(prompt):
    import html, urllib.parse
    t = html.escape((prompt or "image")[:56])
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="768" height="432">'
        '<rect width="100%" height="100%" fill="#121212"/>'
        '<text x="48" y="210" fill="#e8e4d9" font-size="26" font-family="sans-serif">' + t + "</text>"
        "</svg>"
    )
    return {"ok": True, "url": "data:image/svg+xml;charset=utf-8," + urllib.parse.quote(svg)}

def poll_gateway():
    import urllib.request
    gw = (os.environ.get("RELAY_GATEWAY") or "").rstrip("/")
    token = os.environ.get("RELAY_TOKEN") or ""
    if not gw:
        print("未设置网关地址，只提供本机 /chat")
        return
    print("拉取网关任务", gw, flush=True)
    while True:
        try:
            req = urllib.request.Request(
                gw + "/api/worker/next",
                headers={"Authorization": "Bearer " + token, "X-Worker-Name": os.environ.get("RELAY_WORKER_NAME") or "pc-1"},
            )
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read().decode())
            job = data.get("job")
            if not job:
                time.sleep(1.2)
                continue
            print("接到任务", job.get("id"), flush=True)
            if job.get("platform") == "gemini":
                result = make_image(job.get("prompt") or "")
            else:
                result = exec_job({
                    "prompt": job.get("prompt"),
                    "storageState": data.get("storageState"),
                    "timeoutMs": job.get("timeoutMs") or 90000,
                })
            req2 = urllib.request.Request(
                gw + "/api/worker/result",
                data=json.dumps({"id": job.get("id"), "ok": result.get("ok"), "text": result.get("text"), "url": result.get("url"), "error": result.get("error")}, ensure_ascii=False).encode("utf-8"),
                headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req2, timeout=20).read()
        except Exception as e:
            print("拉任务", e, flush=True)
            time.sleep(2)


class Server(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == "__main__":
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
    threading.Thread(target=poll_gateway, daemon=True).start()
    Server(("127.0.0.1", PORT), H).serve_forever()
`;
}
