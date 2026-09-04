export const LOCAL_WORKER = "http://127.0.0.1:18765";

export function localWorkerScript() {
  return `#!/usr/bin/env python3
# Relay 本机 ChatGPT Worker。保持窗口开着，平台试运行会连过来。
import json, os, socket, ssl, subprocess, sys, tempfile, threading, time, base64, queue, re, hashlib
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
ACTIVE_JOBS = {}
ACTIVE_JOBS_LOCK = threading.Lock()
_JOB_SEQ = 0
WARM_STATS = {"warm_hit": 0, "warm_miss": 0, "warm_recycle": 0, "reset_ms": 0, "navigation_ms": 0}
WARM_STATS_LOCK = threading.Lock()
WORKER_NAME_BASE = os.environ.get("RELAY_WORKER_NAME") or "pc-1"
WORKER_INSTANCE_ID = os.environ.get("RELAY_WORKER_INSTANCE_ID") or hashlib.sha256(os.urandom(16)).hexdigest()[:10]
WORKER_NAME = WORKER_NAME_BASE + "@" + WORKER_INSTANCE_ID

class JobRuntimeContext:
    def __init__(self, body=None):
        body = body if isinstance(body, dict) else {}
        lease = body.get("lease") if isinstance(body.get("lease"), dict) else {}
        proxy = body.get("proxy") if isinstance(body.get("proxy"), dict) else {}
        worker = WORKER_NAME
        job_id = str(body.get("id") or body.get("jobId") or "")
        self.job_id = job_id
        self.request_id = str(body.get("requestId") or job_id)
        self.attempt_id = str(body.get("attemptId") or lease.get("attemptId") or "")
        self.lease_id = str(body.get("leaseId") or lease.get("leaseId") or "")
        try:
            self.fencing_token = int(body.get("fencingToken") if body.get("fencingToken") is not None else (lease.get("fencingToken") or 0) or 0)
        except Exception:
            self.fencing_token = 0
        self.account_id = str(body.get("accountId") or "")
        self.proxy_id = str(body.get("proxyId") or proxy.get("id") or "")
        self.worker_id = str(body.get("workerId") or worker)
        self.trace_id = str(body.get("traceId") or job_id)
        self.platform = str(body.get("platform") or "")
        self.model = str(body.get("model") or "")
        self.submission_state = "PREPARING"
        self.retry_safety = "SAFE"
        self.submitted_at = 0
        self.click_attempted = False
        self.reference_hashes = []
        self.historical_hashes = list(body.get("historicalHashes") or [])
        self.requested_reference_count = 0

    def as_meta(self):
        return {
            "id": self.job_id,
            "leaseId": self.lease_id,
            "fencingToken": self.fencing_token or None,
            "attemptId": self.attempt_id,
            "workerId": self.worker_id,
            "accountId": self.account_id,
            "proxyId": self.proxy_id,
            "requestId": self.request_id,
            "traceId": self.trace_id,
        }

def job_runtime_from_body(body):
    return JobRuntimeContext(body)

def register_job(ctx):
    global _JOB_SEQ
    if ctx is None:
        return
    with ACTIVE_JOBS_LOCK:
        if not ctx.job_id:
            _JOB_SEQ += 1
            ctx.job_id = "local-%d" % _JOB_SEQ
        ACTIVE_JOBS[ctx.job_id] = ctx

def unregister_job(ctx):
    if ctx is None:
        return
    with ACTIVE_JOBS_LOCK:
        cur = ACTIVE_JOBS.get(ctx.job_id)
        if cur is ctx:
            ACTIVE_JOBS.pop(ctx.job_id, None)

def snapshot_active_jobs():
    with ACTIVE_JOBS_LOCK:
        return [(c.job_id, c.account_id) for c in list(ACTIVE_JOBS.values()) if c.job_id]

def attach_runtime(ctx, result):
    if not isinstance(result, dict):
        result = {"ok": False, "error": "WORKER_CRASH: empty result", "fault": "worker"}
    if ctx is None:
        return result
    result.setdefault("leaseId", ctx.lease_id)
    if result.get("fencingToken") is None:
        result["fencingToken"] = ctx.fencing_token or None
    result.setdefault("attemptId", ctx.attempt_id)
    result.setdefault("workerId", ctx.worker_id)
    result.setdefault("accountId", ctx.account_id)
    result.setdefault("traceId", ctx.trace_id)
    result.setdefault("proxyId", ctx.proxy_id)
    result.setdefault("requestId", ctx.request_id)
    result.setdefault("retrySafety", ctx.retry_safety or "SAFE")
    result.setdefault("submissionState", ctx.submission_state or "")
    return result

POST_SUBMIT_STATES = set("SUBMITTED GENERATING RESULT_DETECTED RESULT_VALIDATED COMPLETED SUBMISSION_UNCERTAIN RESULT_UNCERTAIN".split())

def set_submission_state(ctx, state):
    if ctx is None:
        return False
    ctx.submission_state = state
    if state == "SUBMITTING":
        ctx.click_attempted = True
        if ctx.retry_safety == "SAFE":
            ctx.retry_safety = "UNKNOWN"
    elif state in POST_SUBMIT_STATES:
        if not ctx.submitted_at:
            ctx.submitted_at = time.time()
        if state == "SUBMISSION_UNCERTAIN":
            ctx.retry_safety = "UNKNOWN"
        else:
            ctx.retry_safety = "UNSAFE"
    return post_phase(state.lower(), ctx)

def fail_job(ctx, error, fault="provider", extra=None):
    extra = dict(extra or {})
    extra["ok"] = False
    extra["error"] = error
    extra["fault"] = fault
    extra["retrySafety"] = (ctx.retry_safety if ctx else None) or "UNKNOWN"
    extra["submissionState"] = (ctx.submission_state if ctx else "") or ""
    return extra

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
    return "PROXY_UNAVAILABLE: assigned proxy cannot egress"

def production_runtime():
    return (os.environ.get("NODE_ENV") or "").strip().lower() == "production"

def proxy_fallback_allowed():
    if production_runtime():
        return False
    return os.environ.get("RELAY_ALLOW_PROXY_FALLBACK") == "1"

def assigned_proxy(body):
    p = (body or {}).get("proxy") or {}
    if isinstance(p, dict) and p.get("server"):
        return p
    return None

def proxy_fingerprint(proxy):
    if not isinstance(proxy, dict):
        return ""
    return str(proxy.get("server") or "").strip()

def proxy_pool_key(proxy):
    if not isinstance(proxy, dict) or not proxy.get("server"):
        return "direct"
    material = json.dumps(
        [
            str(proxy.get("id") or ""),
            str(proxy.get("server") or ""),
            str(proxy.get("username") or ""),
            str(proxy.get("password") or ""),
            str(proxy.get("bypass") or ""),
        ],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()[:20]
    return "%s#%s" % (str(proxy.get("server") or ""), digest)

def playwright_proxy(proxy):
    if not isinstance(proxy, dict) or not proxy.get("server"):
        return None
    return {
        key: proxy[key]
        for key in ("server", "username", "password", "bypass")
        if proxy.get(key)
    }

def proxy_healthy(c):
    if not isinstance(c, dict):
        return False
    server = str(c.get("server") or "")
    if not server:
        return False
    if server.startswith("socks5"):
        try:
            sp = int(server.rsplit(":", 1)[-1])
        except Exception:
            sp = 0
        if sp and not port_open(sp):
            return False
        return socks_https_ok(c)
    return True

def job_proxy(body):
    assigned = assigned_proxy(body)
    pid = str((body or {}).get("proxyId") or (assigned or {}).get("id") or "")
    if assigned:
        if proxy_healthy(assigned):
            out = dict(assigned)
            if pid:
                out["id"] = pid
            out["fingerprint"] = proxy_fingerprint(assigned)
            return out
        print("job_proxy assigned down", assigned.get("server"), "id", pid, flush=True)
        return None
    if proxy_fallback_allowed():
        alt = pick_proxy()
        if alt and proxy_healthy(alt):
            alt = dict(alt)
            alt["fingerprint"] = proxy_fingerprint(alt)
            return alt
        return None
    return None

def proxy_fail_error(body, leonardo=False):
    prefix = "LEONARDO_PROXY_UNAVAILABLE" if leonardo else "PROXY_UNAVAILABLE"
    if assigned_proxy(body):
        return prefix + ": assigned proxy unreachable"
    return prefix + ": job missing account-bound proxy"

def proxy_identity_error(body, used):
    assigned = assigned_proxy(body)
    if not assigned or not isinstance(used, dict):
        return None
    want = str(assigned.get("server") or "").strip()
    got = str(used.get("server") or "").strip()
    if want and got and want != got:
        return "PROXY_IDENTITY_MISMATCH: expected %s got %s" % (want, got)
    pid = str((body or {}).get("proxyId") or assigned.get("id") or "")
    used_id = str(used.get("id") or "")
    if pid and used_id and pid != used_id:
        return "PROXY_IDENTITY_MISMATCH: expected_proxy_id %s got %s" % (pid, used_id)
    return None

def account_lock(aid):
    ACCOUNT_LOCKS.setdefault(aid or "_", threading.Lock())
    return ACCOUNT_LOCKS[aid or "_"]

def post_chunk(text, phase="", ctx=None):
    if os.environ.get("RELAY_STREAM_CHUNKS") == "0" and text and not phase:
        return False
    if ctx is None:
        return False
    gw = (os.environ.get("RELAY_GATEWAY") or "").rstrip("/")
    token = os.environ.get("RELAY_TOKEN") or ""
    jid = ctx.job_id
    if not (gw and token and jid and (text or phase)):
        return not gw
    try:
        import urllib.request
        payload = {
            "id": jid,
            "leaseId": ctx.lease_id or "",
            "fencingToken": ctx.fencing_token or None,
            "attemptId": ctx.attempt_id or "",
            "workerId": ctx.worker_id or "",
            "traceId": ctx.trace_id or "",
            "accountId": ctx.account_id or "",
        }
        if text:
            payload["text"] = text
        if phase:
            payload["phase"] = phase
            if str(phase).upper() == str(ctx.submission_state or "").upper():
                payload["submissionState"] = ctx.submission_state
                payload["retrySafety"] = ctx.retry_safety
        req = urllib.request.Request(
            gw + "/api/worker/chunk",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=8).read()
        return True
    except Exception:
        return False

def post_phase(phase, ctx=None):
    return post_chunk("", phase, ctx)

def post_result(ctx, result):
    gw = (os.environ.get("RELAY_GATEWAY") or "").rstrip("/")
    token = os.environ.get("RELAY_TOKEN") or ""
    if not (gw and token and ctx and ctx.job_id):
        return False
    result = materialize_result_assets(ctx, result if isinstance(result, dict) else {})
    result = attach_runtime(ctx, result)
    payload = {
        "id": ctx.job_id,
        "ok": result.get("ok"),
        "text": result.get("text"),
        "url": result.get("url"),
        "urls": result.get("urls"),
        "error": result.get("error"),
        "fault": result.get("fault"),
        "leaseId": result.get("leaseId") or ctx.lease_id,
        "fencingToken": result.get("fencingToken") if result.get("fencingToken") is not None else (ctx.fencing_token or None),
        "attemptId": result.get("attemptId") or ctx.attempt_id,
        "workerId": result.get("workerId") or ctx.worker_id,
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
        "timing": result.get("timing"),
        "actualProfile": result.get("actualProfile"),
        "profileVerified": result.get("profileVerified"),
        "recoveryLevel": result.get("recoveryLevel"),
        "resultConfidences": result.get("resultConfidences"),
        "resultAssets": result.get("resultAssets"),
        "traceId": ctx.trace_id,
        "accountId": ctx.account_id,
        "proxyId": ctx.proxy_id,
        "requestId": ctx.request_id,
        "retrySafety": result.get("retrySafety") or ctx.retry_safety,
        "submissionState": result.get("submissionState") or ctx.submission_state,
        "assetIds": result.get("assetIds"),
        "workerMediaUploadMs": result.get("workerMediaUploadMs"),
    }
    try:
        import urllib.request
        req = urllib.request.Request(
            gw + "/api/worker/result",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=20).read()
        return True
    except Exception:
        return False

def image_magic_ok(raw):
    if not raw or len(raw) < 2048:
        return False
    if len(raw) >= 8 and raw[0] == 0x89 and raw[1] == 0x50 and raw[2] == 0x4e and raw[3] == 0x47:
        return True
    if len(raw) >= 3 and raw[0] == 0xff and raw[1] == 0xd8 and raw[2] == 0xff:
        return True
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return True
    return False

def data_url_parts(url):
    if not isinstance(url, str) or not url.startswith("data:") or "," not in url:
        return None, None
    header, b64 = url.split(",", 1)
    mime = header[5:].split(";")[0] if header.startswith("data:") else "image/png"
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return None, None
    return raw, mime or "image/png"

def upload_result_media(ctx, raw, mime="image/png"):
    gw = (os.environ.get("RELAY_GATEWAY") or "").rstrip("/")
    token = os.environ.get("RELAY_TOKEN") or ""
    if not (gw and token and ctx and ctx.job_id):
        return None
    try:
        import urllib.request
        req = urllib.request.Request(
            gw + "/api/worker/media",
            data=raw,
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": mime or "image/png",
                "X-Job-Id": ctx.job_id,
                "X-Attempt-Id": ctx.attempt_id or "",
                "X-Lease-Id": ctx.lease_id or "",
                "X-Fencing-Token": str(ctx.fencing_token or 0),
                "X-Worker-Id": ctx.worker_id or "",
            },
            method="POST",
        )
        body = urllib.request.urlopen(req, timeout=60).read()
        return json.loads(body.decode("utf-8") or "{}")
    except Exception as e:
        print("media upload fail", str(e)[:160], flush=True)
        return None

def materialize_result_assets(ctx, result):
    if not result or not result.get("ok"):
        return result
    urls = result.get("urls") if isinstance(result.get("urls"), list) else []
    if result.get("url") and result.get("url") not in urls:
        urls = [result.get("url")] + list(urls)
    if not any(isinstance(u, str) and u.startswith("data:image") for u in urls):
        return result
    t0 = time.time()
    out = []
    ids = []
    assets = []
    confidences = result.get("resultConfidences") if isinstance(result.get("resultConfidences"), list) else []
    for index, u in enumerate(urls):
        if isinstance(u, str) and u.startswith("data:image"):
            raw, mime = data_url_parts(u)
            if not raw or not image_magic_ok(raw):
                result["ok"] = False
                result["error"] = "IMAGE_NOT_FOUND: result magic rejected"
                result.pop("url", None)
                result.pop("urls", None)
                return result
            up = upload_result_media(ctx, raw, mime or "image/png")
            if not up or not up.get("ok") or not up.get("url"):
                result["ok"] = False
                result["error"] = "IMAGE_NOT_FOUND: media upload failed"
                result.pop("url", None)
                result.pop("urls", None)
                return result
            out.append(up.get("url"))
            if up.get("assetId"):
                ids.append(up.get("assetId"))
            assets.append({
                "assetId": up.get("assetId") or "",
                "url": up.get("url") or "",
                "sha256": up.get("sha256") or "",
                "mime": up.get("mime") or (mime or "image/png"),
                "bytes": int(up.get("bytes") or len(raw)),
                "width": int(up.get("width") or 0),
                "height": int(up.get("height") or 0),
                "confidence": confidences[index] if index < len(confidences) else "",
            })
        elif isinstance(u, str) and u:
            out.append(u)
    result["urls"] = out
    result["url"] = out[0] if out else ""
    result["assetIds"] = ids
    result["resultAssets"] = assets
    result["workerMediaUploadMs"] = int((time.time() - t0) * 1000)
    return result

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
                try:
                    with urllib.request.urlopen(url, timeout=20) as resp:
                        raw = resp.read()
                    ext = ""
                    if raw.startswith(b"\\x89PNG\\r\\n\\x1a\\n"):
                        ext = "png"
                    elif raw.startswith(b"\\xff\\xd8\\xff"):
                        ext = "jpg"
                    elif raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
                        ext = "webp"
                    if len(raw) > 32 and ext:
                        path = os.path.join(tempfile.gettempdir(), "relay-img-%s-%d.%s" % (os.getpid(), i, ext))
                        with open(path, "wb") as f:
                            f.write(raw)
                        paths.append(path)
                except Exception:
                    continue
        except Exception:
            continue
    return paths

def ref_body_sizes(images):
    out = set()
    for item in describe_references(images):
        n = int(item.get("byte_size") or 0)
        if n:
            out.add(n)
    return out

def sha256_hex(raw):
    if not raw:
        return ""
    try:
        return hashlib.sha256(raw).hexdigest()
    except Exception:
        return ""

def _image_url(item):
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        return item.get("url") or ""
    return ""

def describe_references(images):
    out = []
    seen = []
    for item in images or []:
        if item in seen:
            continue
        seen.append(item)
        url = _image_url(item)
        if not isinstance(url, str) or not url:
            continue
        raw = None
        mime = "image/png"
        if url.startswith("data:") and "," in url:
            header, b64 = url.split(",", 1)
            mime = (header[5:].split(";")[0] if header.startswith("data:") else "image/png") or "image/png"
            try:
                raw = base64.b64decode(b64)
            except Exception:
                continue
        elif url.startswith("http://") or url.startswith("https://"):
            try:
                import urllib.request
                raw = urllib.request.urlopen(url, timeout=15).read()
            except Exception:
                continue
        if not raw:
            continue
        w, h = image_wh(raw)
        out.append({
            "sha256": sha256_hex(raw),
            "mime": mime.split(";")[0].strip().lower() or "image/png",
            "width": w,
            "height": h,
            "byte_size": len(raw),
        })
    return out

def bind_reference_hashes(ctx, images):
    requested = len([x for x in (images or []) if x])
    descs = describe_references(images)
    hashes = [d["sha256"] for d in descs if d.get("sha256")]
    if ctx is not None:
        ctx.requested_reference_count = requested
        ctx.reference_hashes = hashes
    return requested, hashes, descs

def attachment_incomplete(requested, attached):
    try:
        requested = int(requested or 0)
        attached = int(attached or 0)
    except Exception:
        return "REFERENCE_ATTACH_INCOMPLETE: attached 0 requested 0"
    if requested <= 0:
        return None
    if attached == requested:
        return None
    return "REFERENCE_ATTACH_INCOMPLETE: attached %d requested %d" % (attached, requested)

def result_is_reference(raw, hashes):
    if not raw or not hashes:
        return False
    return sha256_hex(raw) in set(hashes)

def count_gemini_refs(page):
    try:
        n = page.evaluate("""() => {
          const imgs = [...document.querySelectorAll('form img, [data-testid*="attachment"] img')];
          const remove = [...document.querySelectorAll('button[aria-label*="Remove" i], button[aria-label*="移除"]')];
          if (remove.length) return remove.length;
          return imgs.length;
        }""")
        return int(n or 0)
    except Exception:
        return 0

def count_leonardo_refs(page):
    try:
        n = page.evaluate("""() => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            return r.width >= 16 && r.height >= 16 && st.display !== 'none' && st.visibility !== 'hidden';
          };
          const ta = document.querySelector('#home-prompt-textarea, textarea[placeholder*="prompt" i], textarea[placeholder*="image" i], [data-testid*="prompt"] textarea, textarea');
          const root = ta ? (ta.closest('[data-testid="prompt-container"]') || ta.parentElement) : null;
          if (!root) return 0;
          const remove = [...root.querySelectorAll('button')].filter((b) => {
            const a = (b.getAttribute('aria-label') || '').toLowerCase();
            const t = (b.innerText || '').trim().toLowerCase();
            return visible(b) && (/remove reference|remove image|clear reference/.test(a) || t === '×' || t === 'x');
          });
          const thumbs = [...root.querySelectorAll('img')].filter((im) => {
            const r = im.getBoundingClientRect();
            return visible(im) && r.width <= 320 && r.height <= 320 && r.bottom > 0 && r.top < window.innerHeight;
          });
          return Math.max(remove.length, thumbs.length);
        }""")
        return int(n or 0)
    except Exception:
        return 0

def attach_images(page, images):
    paths = materialize_images(images)
    requested = len([item for item in (images or []) if item])
    if requested <= 0:
        return 0
    if not paths:
        return 0
    if len(paths) != requested:
        return len(paths)
    try:
        loc = page.locator("input[type=file]")
        if loc.count() > 0:
            loc.first.set_input_files(paths)
            return wait_composer_files(page, requested)
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
    return wait_composer_files(page, requested)

def count_chat_refs(page):
    try:
        return int(page.evaluate("""() => {
          const remove = [...document.querySelectorAll('button[aria-label*="Remove" i], button[aria-label*="移除"]')];
          if (remove.length) return remove.length;
          return document.querySelectorAll('form img, [data-testid*="attachment"] img').length;
        }""") or 0)
    except Exception:
        return 0

def wait_composer_files(page, expected=1, timeout_ms=8000):
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        attached = count_chat_refs(page)
        if attached >= max(1, int(expected or 1)):
            return attached
        time.sleep(0.12)
    return count_chat_refs(page)

def leonardo_refs_attached(page):
    return count_leonardo_refs(page) > 0

def attach_leonardo_refs(page, images):
    seen = []
    for item in images or []:
        if item and item not in seen:
            seen.append(item)
    paths = materialize_images(seen[:6])
    if not paths:
        return "LEONARDO_DOM_CHANGED: cannot read reference images"
    close_leonardo_drawers(page)
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
        button = page.get_by_role("button", name=re.compile(r"^Generate(?:\\s+\\d+)?$", re.I)).last
        if button.count() > 0 and button.is_visible() and button.is_enabled():
            label = (button.inner_text() or "Generate").strip()
            button.click(timeout=2200)
            print("leonardo generate click playwright", label, flush=True)
            return True
    except Exception as e:
        print("leonardo generate playwright fallback", str(e)[:100], flush=True)
    try:
        clicked = page.evaluate("""() => {
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.top < innerHeight && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const buttons = [...document.querySelectorAll('button')].filter((button) => {
            if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
            const aria = (button.getAttribute('aria-label') || '').trim();
            const text = (button.innerText || '').replace(/\\s+/g, ' ').trim();
            return /^generate\\b/i.test(aria) || /^(generate|create)(\\s+\\d+)?$/i.test(text);
          });
          const button = buttons[buttons.length - 1];
          if (button) {
            button.click();
            return (button.getAttribute('aria-label') || button.innerText || 'visible').trim();
          }
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
              const visible = (element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.top < innerHeight && style.display !== 'none' && style.visibility !== 'hidden';
              };
              return [...document.querySelectorAll('button')].some((button) => {
                if (!visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
                const aria = (button.getAttribute('aria-label') || '').trim();
                const text = (button.innerText || '').replace(/\\s+/g, ' ').trim();
                return /^generate\\b/i.test(aria) || /^(generate|create)(\\s+\\d+)?$/i.test(text);
              });
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
    n = 0
    while time.time() < deadline:
        n = count_leonardo_refs(page)
        if n > 0:
            return n
        try:
            page.wait_for_timeout(250)
        except Exception:
            time.sleep(0.25)
    return count_leonardo_refs(page)


def warm_bump(key, n=1):
    with WARM_STATS_LOCK:
        WARM_STATS[key] = int(WARM_STATS.get(key) or 0) + int(n)

def classify_image_runtime(page, provider):
    try:
        url = page.url or ""
    except Exception:
        return "INVALID"
    pst = detect_page_state(page, provider)
    if pst in ("LOGIN_REQUIRED", "CHALLENGE", "ACCOUNT_RESTRICTED"):
        return "INVALID"
    if pst in ("GENERATING",):
        return "GENERATING"
    if provider == "gemini":
        if "gemini.google.com" not in url:
            return "INVALID"
        if pst not in ("COMPOSER_READY", "RESULT_READY", "AUTHENTICATED", "IMAGE_GENERATOR_READY"):
            if pst in ("RATE_LIMITED",):
                return "INVALID"
        composer = False
        try:
            composer = page.locator("div.ql-editor, rich-textarea, div[contenteditable='true']").first.count() > 0
        except Exception:
            composer = False
        if not composer:
            return "INVALID"
        try:
            prompt_text = page.evaluate("""() => {
              const el = document.querySelector('div.ql-editor, rich-textarea, div[contenteditable="true"]');
              return ((el && (el.innerText || el.value || el.textContent)) || '').trim();
            }""") or ""
        except Exception:
            prompt_text = ""
        if prompt_text:
            return "DIRTY"
        if count_gemini_refs(page) > 0:
            return "DIRTY"
        return "WARM_IDLE"
    if provider == "leonardo":
        if "leonardo.ai" not in url:
            return "INVALID"
        on_gen = "/generate" in url.lower() or "ai-creation" in url.lower()
        try:
            on_gen = on_gen or page.locator("#home-prompt-textarea, textarea[placeholder*='prompt' i]").count() > 0
        except Exception:
            pass
        if not on_gen:
            return "INVALID"
        try:
            prompt_text = page.evaluate("""() => {
              const el = document.querySelector('#home-prompt-textarea, textarea[placeholder*="prompt" i], textarea, div[contenteditable="true"]');
              return ((el && (el.value || el.innerText || el.textContent)) || '').trim();
            }""") or ""
        except Exception:
            prompt_text = ""
        if prompt_text:
            return "DIRTY"
        if count_leonardo_refs(page) > 0:
            return "DIRTY"
        return "WARM_IDLE"
    return "INVALID"

def cleanup_gemini(page):
    t0 = time.time()
    try:
        for _ in range(8):
            loc = page.locator('button[aria-label*="Remove"], button[aria-label*="移除"]').first
            if loc.count() <= 0:
                break
            loc.click(timeout=800)
            page.wait_for_timeout(120)
        page.evaluate("""() => {
          const el = document.querySelector('div.ql-editor, rich-textarea, div[contenteditable="true"]');
          if (!el) return;
          el.focus();
          if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
            el.innerHTML = '<p><br></p>';
          } else {
            el.value = '';
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }""")
    except Exception:
        pass
    warm_bump("reset_ms", int((time.time() - t0) * 1000))
    return classify_image_runtime(page, "gemini") == "WARM_IDLE"

def cleanup_leonardo(page):
    t0 = time.time()
    try:
        for _ in range(8):
            if count_leonardo_refs(page) <= 0:
                break
            removed = page.evaluate("""() => {
              const ta = document.querySelector('#home-prompt-textarea, textarea[placeholder*="prompt" i], textarea[placeholder*="image" i], [data-testid*="prompt"] textarea, textarea');
              const root = ta ? (ta.closest('[data-testid="prompt-container"]') || ta.parentElement) : null;
              if (!root) return false;
              const b = [...root.querySelectorAll('button')].find((el) => {
                const a = (el.getAttribute('aria-label') || '').toLowerCase();
                const t = (el.innerText || '').trim();
                return /remove reference|remove image|clear reference/.test(a) || t === '×' || t === 'x';
              });
              if (!b) return false;
              b.click();
              return true;
            }""")
            if not removed:
                break
            try:
                page.wait_for_timeout(180)
            except Exception:
                time.sleep(0.18)
        leonardo_js_fill(page, "")
    except Exception:
        pass
    warm_bump("reset_ms", int((time.time() - t0) * 1000))
    return classify_image_runtime(page, "leonardo") == "WARM_IDLE"

def ensure_gemini_ready(page):
    st = classify_image_runtime(page, "gemini")
    if st == "WARM_IDLE":
        warm_bump("warm_hit")
        return True, st
    if st == "DIRTY":
        cleanup_gemini(page)
        st = classify_image_runtime(page, "gemini")
        if st == "WARM_IDLE":
            warm_bump("warm_recycle")
            return True, st
    warm_bump("warm_miss")
    t0 = time.time()
    page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=45000)
    time.sleep(1.0)
    warm_bump("navigation_ms", int((time.time() - t0) * 1000))
    st = classify_image_runtime(page, "gemini")
    if st == "DIRTY":
        cleanup_gemini(page)
        st = classify_image_runtime(page, "gemini")
    return st == "WARM_IDLE", st

def ensure_leonardo_ready(page, navigate):
    st = classify_image_runtime(page, "leonardo")
    if st == "WARM_IDLE":
        warm_bump("warm_hit")
        return True, st
    if st == "DIRTY":
        cleanup_leonardo(page)
        st = classify_image_runtime(page, "leonardo")
        if st == "WARM_IDLE":
            warm_bump("warm_recycle")
            return True, st
    warm_bump("warm_miss")
    t0 = time.time()
    navigate()
    warm_bump("navigation_ms", int((time.time() - t0) * 1000))
    st = classify_image_runtime(page, "leonardo")
    if st == "DIRTY":
        cleanup_leonardo(page)
        st = classify_image_runtime(page, "leonardo")
    return st == "WARM_IDLE", st

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


def _env_ms(name, default):
    try:
        v = int(os.environ.get(name) or str(default))
        return max(200, min(20000, v))
    except Exception:
        return default

def chat_stable_ms():
    return _env_ms("RELAY_CHAT_STABLE_MS", 1500)

def chat_confirm_ms():
    return _env_ms("RELAY_CHAT_CONFIRM_MS", 600)

def chat_stop_stable_ms():
    return _env_ms("RELAY_CHAT_STOP_STABLE_MS", 400)

class AssistantCompletionDetector:
    WAITING_FIRST_DELTA = "WAITING_FIRST_DELTA"
    STREAMING = "STREAMING"
    POSSIBLY_COMPLETE = "POSSIBLY_COMPLETE"
    CONFIRMED_COMPLETE = "CONFIRMED_COMPLETE"
    RESULT_UNCERTAIN = "RESULT_UNCERTAIN"

    def __init__(self, stable_ms=None, confirm_ms=None, stop_stable_ms=None):
        self.stable_ms = int(stable_ms if stable_ms is not None else chat_stable_ms())
        self.confirm_ms = int(confirm_ms if confirm_ms is not None else chat_confirm_ms())
        self.stop_stable_ms = int(stop_stable_ms if stop_stable_ms is not None else chat_stop_stable_ms())
        self.state = self.WAITING_FIRST_DELTA
        self.send_ack_at = 0
        self.assistant_node_created_at = 0
        self.first_delta_at = 0
        self.last_delta_at = 0
        self.stop_seen = False
        self.stop_now = False
        self.stop_gone_at = 0
        self.network_request_seen = False
        self.network_response_seen = False
        self.network_finished = False
        self.network_finished_at = 0
        self.semantic_complete = False
        self.streamed_text = ""
        self.candidate_text = ""
        self.possibly_at = 0
        self.completion_signal = ""
        self.final_text_replaced = False
        self.premature_guard_triggered = False
        self.very_short_completion = False

    def on_submit(self, now=None):
        self.send_ack_at = now if now is not None else time.time()

    def on_assistant_node(self, now=None):
        if not self.assistant_node_created_at:
            self.assistant_node_created_at = now if now is not None else time.time()

    def on_network_request(self, now=None):
        self.network_request_seen = True

    def on_network_response(self, now=None):
        self.network_response_seen = True

    def on_network_finished(self, now=None):
        self.network_finished = True
        if not self.network_finished_at:
            self.network_finished_at = now if now is not None else time.time()

    def on_semantic_complete(self, now=None):
        self.semantic_complete = True

    def on_stop(self, visible, now=None):
        now = now if now is not None else time.time()
        vis = bool(visible)
        if vis:
            self.stop_seen = True
            self.stop_now = True
            self.stop_gone_at = 0
            if self.state == self.POSSIBLY_COMPLETE:
                self.state = self.STREAMING
                self.possibly_at = 0
                self.candidate_text = ""
        else:
            if self.stop_now and self.stop_seen and not self.stop_gone_at:
                self.stop_gone_at = now
            self.stop_now = False

    def on_delta(self, text, now=None):
        now = now if now is not None else time.time()
        t = text or ""
        if not t or t == self.streamed_text:
            return self.state
        self.streamed_text = t
        if not self.first_delta_at:
            self.first_delta_at = now
        self.last_delta_at = now
        if self.state in (self.WAITING_FIRST_DELTA, self.POSSIBLY_COMPLETE, self.CONFIRMED_COMPLETE):
            if self.state in (self.POSSIBLY_COMPLETE, self.CONFIRMED_COMPLETE):
                self.premature_guard_triggered = True
            self.state = self.STREAMING
            self.possibly_at = 0
            self.candidate_text = ""
        return self.state

    def _idle_ms(self, now):
        if not self.last_delta_at:
            return 0
        return int(round((now - self.last_delta_at) * 1000.0))

    def tick(self, now=None):
        now = now if now is not None else time.time()
        if self.state in (self.CONFIRMED_COMPLETE, self.WAITING_FIRST_DELTA):
            return self.state
        idle_ms = self._idle_ms(now)
        if self.state == self.STREAMING:
            signal = "fallback_stable"
            need = self.stable_ms
            if self.stop_seen and (not self.stop_now):
                need = self.stop_stable_ms
                signal = "stop_cycle"
            elif self.network_finished:
                need = min(need, max(self.stop_stable_ms, 800))
                signal = "network_finished"
            elif self.semantic_complete:
                need = min(need, max(self.stop_stable_ms, 800))
                signal = "semantic"
            if idle_ms >= need and self.streamed_text:
                self.state = self.POSSIBLY_COMPLETE
                self.possibly_at = now
                self.candidate_text = self.streamed_text
                self.completion_signal = signal
        if self.state == self.POSSIBLY_COMPLETE:
            if self.streamed_text != self.candidate_text:
                self.premature_guard_triggered = True
                self.state = self.STREAMING
                self.possibly_at = 0
                return self.state
            if self.stop_now:
                self.state = self.STREAMING
                self.possibly_at = 0
                return self.state
            held = int(round((now - self.possibly_at) * 1000.0)) if self.possibly_at else 0
            if held >= self.confirm_ms:
                self.state = self.CONFIRMED_COMPLETE
                if len((self.streamed_text or "").strip()) < 8:
                    self.very_short_completion = True
        return self.state

    def report(self, final_dom=""):
        now = time.time()
        return {
            "chat_stop_seen": bool(self.stop_seen),
            "chat_completion_signal": self.completion_signal,
            "chat_stable_ms": self._idle_ms(now) if self.last_delta_at else 0,
            "chat_final_dom_length": len(final_dom or self.streamed_text or ""),
            "chat_streamed_length": len(self.streamed_text or ""),
            "chat_final_text_replaced": bool(self.final_text_replaced),
            "chat_premature_guard_triggered": bool(self.premature_guard_triggered),
            "completion_without_stop_seen": bool(self.state == self.CONFIRMED_COMPLETE and not self.stop_seen),
            "very_short_completion": bool(self.very_short_completion),
            "state": self.state,
        }


def stop_generating_visible(page, stop_sels=None):
    names = []
    for s in (stop_sels or []):
        if s and s not in names:
            names.append(s)
    for s in (
        "button[data-testid='stop-button']",
        "button[aria-label*='Stop generating']",
        "button[aria-label*='Stop streaming']",
        "button[aria-label*='Stop']",
        "button[aria-label*='停止']",
    ):
        if s not in names:
            names.append(s)
    try:
        loc = page.locator(",".join(names[:6])).first
        return bool(loc.count() > 0 and loc.is_visible())
    except Exception:
        return False

def read_assistant_full(page):
    try:
        return (page.evaluate(
            """() => {
              const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
              const before = window.__relayBefore || 0;
              if (nodes.length <= before) return '';
              return (nodes[nodes.length - 1].innerText || '').trim();
            }"""
        ) or "").strip()
    except Exception:
        return ""

def last_assistant_complete_signal(page):
    try:
        return bool(page.evaluate(
            """() => {
              const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
              const before = window.__relayBefore || 0;
              if (nodes.length <= before) return false;
              const n = nodes[nodes.length - 1];
              const q = (s) => n.querySelector(s);
              return !!(
                q('[data-testid="copy-turn-action-button"]') ||
                q('[data-testid="good-response"]') ||
                q('button[aria-label*="Copy"]') ||
                q('button[aria-label*="Good response"]') ||
                q('button[data-testid="voice-play-turn-action-button"]')
              );
            }"""
        ))
    except Exception:
        return False


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
        try:
            matches = page.locator(s)
            count = min(4, matches.count())
            for index in range(count):
                loc = matches.nth(index)
                if loc.is_visible():
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
    out = {"acked": False, "clicked": False, "composer_empty": False, "turn_increased": False}
    box = first_visible(page, inp)
    if box is None:
        return out
    if not fill_composer(page, box, prompt):
        return out
    waited = time.time() + 2
    while time.time() < waited and not send_button_enabled(page):
        time.sleep(0.1)
    before_as = page.locator("[data-message-author-role='assistant']").count()
    before_user = page.locator("[data-message-author-role='user']").count()
    filled = composer_text(page)
    click_send(page, first_visible(page, send))
    out["clicked"] = True
    if wait_send_ack(page, before_user, before_as, None, stop_sels, filled):
        out["acked"] = True
        return out
    try:
        page.keyboard.press("Enter")
    except Exception:
        pass
    if wait_send_ack(page, before_user, before_as, 2000, stop_sels, filled):
        out["acked"] = True
        return out
    try:
        out["composer_empty"] = bool(filled and not composer_text(page))
        after_user = page.locator("[data-message-author-role='user']").count()
        after_as = page.locator("[data-message-author-role='assistant']").count()
        out["turn_increased"] = after_user > before_user or after_as > before_as
    except Exception:
        pass
    if out["composer_empty"] or out["turn_increased"]:
        out["acked"] = True
    return out

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
        page.wait_for_selector("#prompt-textarea, textarea#prompt-textarea, [contenteditable='true'], [role='textbox']", state="visible", timeout=timeout_ms)
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

PRODUCTION_CONFIDENCE = set(("VERIFIED", "HIGH"))

def score_result_candidate(c):
    if not c or not c.get("src"):
        return "REJECT"
    if c.get("historicalDuplicate") or c.get("referenceDuplicate"):
        return "REJECT"
    src = str(c.get("src") or "")
    low = src.lower()
    for bad in ("favicon", "avatar", "logo", "sprite", "icon", "/static/", "profile"):
        if bad in low:
            return "REJECT"
    if src.startswith("data:image/svg"):
        return "REJECT"
    w = int(c.get("width") or 0)
    h = int(c.get("height") or 0)
    if w and h and (w < 64 or h < 64):
        return "REJECT"
    if not c.get("isNewSrc") and not c.get("isNewContainer"):
        return "REJECT"
    if c.get("isNewSrc") and c.get("domainMatch") and c.get("networkCaptured"):
        return "VERIFIED"
    if c.get("isNewContainer") and c.get("isNewSrc") and c.get("createdAfterSubmit") and c.get("domainMatch"):
        return "VERIFIED"
    if c.get("isNewSrc") and c.get("domainMatch") and (c.get("isNewContainer") or c.get("createdAfterSubmit")):
        return "HIGH"
    if c.get("isNewSrc") and c.get("domainMatch") and c.get("promptMatch") and c.get("resultAction") and w >= 256 and h >= 256:
        return "HIGH"
    if c.get("isNewSrc"):
        return "MEDIUM"
    return "LOW"

def pick_accepted_candidates(cands, n=1):
    scored = []
    for c in cands or []:
        conf = score_result_candidate(c)
        c = dict(c)
        c["confidence"] = conf
        if conf in PRODUCTION_CONFIDENCE:
            scored.append(c)
    scored.sort(key=lambda c: (
        400 if c["confidence"] == "VERIFIED" else 300,
        int(c.get("width") or 0) * int(c.get("height") or 0),
        1 if c.get("isNewContainer") else 0,
    ), reverse=True)
    want = max(1, int(n or 1))
    return scored[:want]

def create_generation_boundary(page, ctx=None, provider="", prompt=""):
    snap = {"ids": [], "gens": [], "srcs": []}
    try:
        snap = page.evaluate("""() => {
          const sel = 'model-response, .response-container, [data-message-author-role], [data-testid*="generation"], article, [class*="ImageCard"], [class*="result"]';
          const nodes = [...document.querySelectorAll(sel)];
          const ids = nodes.map((el, i) => el.getAttribute('data-generation-id') || el.getAttribute('data-response-id') || el.id || ('c'+i));
          window.__relayBaselineContainers = ids;
          const srcs = [...document.querySelectorAll('img')].map((im) => im.getAttribute('src') || '').filter(Boolean);
          window.__relayBaselineSrcs = srcs;
          return { ids, gens: ids, srcs };
        }""") or snap
    except Exception:
        try:
            snap["srcs"] = snapshot_image_srcs(page)
        except Exception:
            snap["srcs"] = []
    refs = list(getattr(ctx, "reference_hashes", []) or []) if ctx else []
    return {
        "request_id": getattr(ctx, "request_id", "") if ctx else "",
        "attempt_id": getattr(ctx, "attempt_id", "") if ctx else "",
        "provider": provider,
        "prompt": str(prompt or "")[:4000],
        "submitted_at": time.time(),
        "baseline_result_container_ids": snap.get("ids") or [],
        "baseline_generation_ids": snap.get("gens") or [],
        "baseline_asset_urls": snap.get("srcs") or [],
        "baseline_asset_hashes": list(getattr(ctx, "historical_hashes", []) or []) if ctx else [],
        "reference_hashes": refs,
    }

def collect_result_candidates(page, boundary, provider=""):
    baseline = (boundary or {}).get("baseline_asset_urls") or []
    containers = (boundary or {}).get("baseline_result_container_ids") or []
    ref_hashes = set((boundary or {}).get("reference_hashes") or [])
    raw = []
    try:
        raw = page.evaluate(
            """(args) => {
              const baseline = new Set(args.baseline || []);
              const baselineC = new Set(args.containers || []);
              const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9\\u3400-\\u9fff]+/g, '');
              const promptNorm = normalize(args.prompt || '');
              const promptNeedle = promptNorm.slice(0, 48);
              const domainRe = /googleusercontent|ggpht|leonardo\\.ai|leonardocdn|leonardousercontent|oaidalle|oaiusercontent|openaiusercontent|blob\\.core\\.windows\\.net|data:image/;
              const uiRe = /favicon|avatar|logo|sprite|icon|emoji|\\/static\\/|profile/;
              const sel = 'model-response, .response-container, [data-message-author-role], [data-testid*="generation"], article, [class*="ImageCard"], [class*="result"]';
              const nodes = [...document.querySelectorAll(sel)];
              const out = [];
              const seen = new Set();
              const push = (root, containerId, isNewContainer) => {
                if (!root) return;
                for (const im of root.querySelectorAll('img')) {
                  const src = im.currentSrc || im.src || im.getAttribute('src') || '';
                  if (!src || seen.has(src)) continue;
                  seen.add(src);
                  const r = im.getBoundingClientRect();
                  const alt = im.getAttribute('alt') || '';
                  const altNorm = normalize(alt);
                  const actionRoot = root === document.body ? im.closest(sel) : root;
                  const actionBlob = actionRoot ? [...actionRoot.querySelectorAll('button, [role="button"]')]
                    .map((el) => (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || ''))
                    .join(' ') : '';
                  out.push({
                    src,
                    containerId,
                    createdAfterSubmit: isNewContainer,
                    isNewContainer,
                    isNewSrc: !baseline.has(src),
                    domainMatch: domainRe.test(src) || src.startsWith('blob:'),
                    width: Math.round(im.naturalWidth || r.width || 0),
                    height: Math.round(im.naturalHeight || r.height || 0),
                    bytes: 0,
                    mime: '',
                    sha256: '',
                    referenceDuplicate: false,
                    historicalDuplicate: baseline.has(src),
                    promptMatch: promptNeedle.length >= 6 && altNorm.includes(promptNeedle),
                    resultAction: /download|remove|reuse prompt|copy prompt|make public|add to canva|positive feedback/i.test(actionBlob),
                    ui: uiRe.test(src),
                    fallback: containerId === 'page-fallback',
                  });
                }
              };
              nodes.forEach((el, i) => {
                const id = el.getAttribute('data-generation-id') || el.getAttribute('data-response-id') || el.id || ('c'+i);
                push(el, id, !baselineC.has(id));
              });
              const hasGood = out.some((x) => x.isNewSrc && x.domainMatch && !x.ui && !x.historicalDuplicate);
              if (!hasGood) push(document.body, 'page-fallback', false);
              return out;
            }""",
            {"baseline": baseline, "containers": containers, "provider": provider, "prompt": (boundary or {}).get("prompt") or ""},
        ) or []
    except Exception:
        raw = []
    cands = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        if row.get("ui"):
            continue
        src = row.get("src") or ""
        if src.startswith("data:image") and "," in src:
            try:
                raw = base64.b64decode(src.split(",", 1)[1])
                row["sha256"] = sha256_hex(raw)
                row["bytes"] = len(raw)
            except Exception:
                pass
        if ref_hashes and row.get("sha256") in ref_hashes:
            row["referenceDuplicate"] = True
        if row.get("sha256") and row.get("sha256") in set((boundary or {}).get("baseline_asset_hashes") or []):
            row["historicalDuplicate"] = True
        cands.append(row)
    return cands

def gemini_result_locator(page, boundary):
    return collect_result_candidates(page, boundary, "gemini")

def leonardo_result_locator(page, boundary):
    return collect_result_candidates(page, boundary, "leonardo")

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

MAX_BROWSERS = int(os.environ.get("RELAY_MAX_BROWSERS") or "4")
MAX_CTX = int(os.environ.get("RELAY_MAX_CTX_PER_BROWSER") or "8")
CTX_IDLE = int(os.environ.get("RELAY_CTX_IDLE") or "600")
CTX_MAX_REQ = int(os.environ.get("RELAY_CTX_MAX_REQ") or "20")
SHARD_COUNT = max(1, int(os.environ.get("RELAY_PLAYWRIGHT_SHARDS") or "3"))
SHARDS = []
SHARD_LOCAL = threading.local()
DISPATCHED = 0
DISPATCH_LOCK = threading.Lock()

def shard_for_account(aid):
    n = max(1, SHARD_COUNT)
    text = str(aid or "")
    if not text:
        return 0
    h = 2166136261
    for ch in text:
        h ^= ord(ch)
        h = (h * 16777619) & 0xffffffff
    return h % n

def proxy_from_plane_row(p):
    if not isinstance(p, dict):
        return None
    if p.get("server"):
        out = dict(p)
        out["id"] = str(p.get("id") or "")
        return out
    typ = str(p.get("type") or "socks5").lower()
    host = str(p.get("host") or "")
    port = p.get("port")
    if typ == "ss":
        lp = p.get("localPort") or os.environ.get("RELAY_SS_LOCAL_PORT") or "18080"
        server = "socks5://127.0.0.1:%s" % lp
    elif host and port:
        scheme = "http" if typ == "http" else "socks5"
        server = "%s://%s:%s" % (scheme, host, port)
    else:
        return None
    return {"id": str(p.get("id") or ""), "server": server, "username": p.get("username") or ""}

def load_account_proxies():
    out = {}
    raw = os.environ.get("RELAY_ACCOUNT_PROXIES") or ""
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                for k, v in parsed.items():
                    row = proxy_from_plane_row(v) if isinstance(v, dict) else None
                    if row:
                        out[str(k)] = row
        except Exception:
            pass
    for name in ("account-proxies.json", "control-plane.json"):
        path = os.path.join(HERE, name)
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            continue
        if name == "control-plane.json" and isinstance(data, dict):
            proxies = {}
            for p in data.get("proxies") or []:
                row = proxy_from_plane_row(p)
                if row and row.get("id"):
                    proxies[row["id"]] = row
            for acc in data.get("accounts") or []:
                if not isinstance(acc, dict):
                    continue
                aid = str(acc.get("id") or "")
                pid = acc.get("proxyId")
                bound = proxies.get(pid) if pid else None
                if aid and bound:
                    out[aid] = bound
        elif isinstance(data, dict):
            for k, v in data.items():
                row = proxy_from_plane_row(v) if isinstance(v, dict) else None
                if row:
                    out[str(k)] = row
    sess_dir = os.path.join(HERE, "sessions")
    if os.path.isdir(sess_dir):
        for n in os.listdir(sess_dir):
            if not n.endswith(".proxy.json"):
                continue
            aid = n[:-11]
            try:
                with open(os.path.join(sess_dir, n), "r", encoding="utf-8") as f:
                    row = proxy_from_plane_row(json.load(f))
                if aid and row:
                    out[aid] = row
            except Exception:
                continue
    return out

def account_bound_proxy(aid, proxies=None):
    table = proxies if isinstance(proxies, dict) else load_account_proxies()
    row = table.get(str(aid or ""))
    if isinstance(row, dict) and row.get("server"):
        return row
    return None

def warmup_plan(found, shard_idx, proxies=None, shard_count=None):
    n = max(1, int(shard_count if shard_count is not None else SHARD_COUNT))
    idx = int(shard_idx)
    table = proxies if isinstance(proxies, dict) else {}
    out = []
    seen = set()
    for aid, path in found or []:
        aid = str(aid or "")
        if not aid or aid in seen:
            continue
        seen.add(aid)
        h = 2166136261
        for ch in aid:
            h ^= ord(ch)
            h = (h * 16777619) & 0xffffffff
        if (h % n) != idx:
            continue
        proxy = account_bound_proxy(aid, table)
        if not proxy:
            continue
        out.append({"accountId": aid, "path": path, "proxy": proxy, "shard": idx})
    return out

class PlaywrightShard:
    def __init__(self, idx):
        self.idx = idx
        self.pw = None
        self.q = queue.Queue()
        self.browser_pool = {}
        self.ctx_pool = {}
        self.lock = threading.Lock()
        self.thread = None
        self.started = False

    def start(self):
        if self.thread is not None and self.thread.is_alive():
            return
        self.thread = threading.Thread(target=self.loop, name="pw-shard-%d" % self.idx, daemon=True)
        self.thread.start()
        self.started = True

    def loop(self):
        SHARD_LOCAL.shard = self
        try:
            if os.environ.get("RELAY_SKIP_WARM") != "1":
                warm_sessions()
        except Exception as e:
            print("warmup fail shard", self.idx, e, flush=True)
        while True:
            item = self.q.get()
            if item is None:
                break
            body, box = item
            try:
                SHARD_LOCAL.shard = self
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

def ensure_shards():
    global SHARDS
    if not SHARDS:
        SHARDS = [PlaywrightShard(i) for i in range(SHARD_COUNT)]
    return SHARDS

def start_shards():
    for s in ensure_shards():
        s.start()
    print("playwright shards", SHARD_COUNT, flush=True)
    return SHARDS

def current_shard():
    s = getattr(SHARD_LOCAL, "shard", None)
    if s is not None:
        return s
    ensure_shards()
    return SHARDS[0] if SHARDS else None

def pick_shard(body):
    ensure_shards()
    aid = ""
    if isinstance(body, dict):
        aid = str(body.get("accountId") or "")
    return SHARDS[shard_for_account(aid)]

def shard_queue_depths():
    return [s.q.qsize() for s in SHARDS] if SHARDS else []

def shard_browser_count():
    return sum(len(s.browser_pool) for s in SHARDS) if SHARDS else 0

def shard_context_count():
    return sum(len(s.ctx_pool) for s in SHARDS) if SHARDS else 0

def remember_page(ctx_key, page):
    shard = current_shard()
    if shard is None:
        return
    with shard.lock:
        row = shard.ctx_pool.get(ctx_key)
        if row:
            row["page"] = page

def reset_playwright():
    shard = current_shard()
    if shard is None:
        return
    with shard.lock:
        for row in list(shard.ctx_pool.values()):
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
        shard.ctx_pool.clear()
        for b in list(shard.browser_pool.values()):
            try:
                b.close()
            except Exception:
                pass
        shard.browser_pool.clear()
        try:
            if shard.pw:
                shard.pw.stop()
        except Exception:
            pass
        shard.pw = None

def playwright_inst():
    shard = current_shard()
    if shard is None:
        ensure_shards()
        shard = current_shard()
    if shard.pw is None:
        from playwright.sync_api import sync_playwright
        shard.pw = sync_playwright().start()
    return shard.pw

def noise_route(route):
    return route.continue_()

def arm_page(page):
    return

def warm_sessions():
    shard = current_shard()
    if shard is None:
        return
    sess_dir = os.path.join(HERE, "sessions")
    found = []
    if os.path.isdir(sess_dir):
        for n in os.listdir(sess_dir):
            path = os.path.join(sess_dir, n)
            try:
                if n.endswith(".json") and not n.endswith(".proxy.json") and os.path.getsize(path) > 5000:
                    found.append((n[:-5], path))
            except Exception:
                continue
    plan = warmup_plan(found, shard.idx, load_account_proxies())
    if not plan:
        print("warmup skip shard", shard.idx, "no shard-owned account with bound proxy", flush=True)
        return
    playwright_inst()
    for row in plan:
        aid = row["accountId"]
        try:
            with open(row["path"], "r", encoding="utf-8") as f:
                state = json.load(f)
            if not (state.get("cookies") or []):
                continue
            proxy = row["proxy"]
            browser, ctx, page, key = get_pooled_context(proxy, state, aid)
            if page is None:
                page = ctx.new_page()
                arm_page(page)
                page.goto("https://chatgpt.com/?temporary-chat=true", wait_until="domcontentloaded", timeout=25000)
                page.wait_for_selector("#prompt-textarea, textarea#prompt-textarea", timeout=15000)
            remember_page(key, page)
            print("session warm", aid[:8], "shard", shard.idx, "proxy", proxy.get("id") or proxy.get("server"), flush=True)
        except Exception as e:
            print("session warm fail", aid[:8], e, flush=True)

def pw_loop():
    start_shards()

def pool_enabled():
    if os.environ.get("RELAY_TEST_URL"):
        return False
    return os.environ.get("RELAY_BROWSER_POOL", "1") != "0"

def recycle_idle_contexts():
    shard = current_shard()
    if shard is None:
        return
    now = time.time()
    dead = []
    for key, row in list(shard.ctx_pool.items()):
        if now - row.get("last", now) > CTX_IDLE or row.get("n", 0) >= CTX_MAX_REQ:
            dead.append(key)
    for key in dead:
        row = shard.ctx_pool.pop(key, None)
        try:
            if row and row.get("ctx"):
                row["ctx"].close()
        except Exception:
            pass

def get_pooled_context(proxy, storage_state, account_id):
    shard = current_shard()
    p = playwright_inst()
    proxy_key = proxy_pool_key(proxy)
    with shard.lock:
        recycle_idle_contexts()
        browser = shard.browser_pool.get(proxy_key)
        if browser is None or not getattr(browser, "is_connected", lambda: True)():
            if len(shard.browser_pool) >= MAX_BROWSERS:
                old_key = next(iter(shard.browser_pool))
                try:
                    shard.browser_pool[old_key].close()
                except Exception:
                    pass
                shard.browser_pool.pop(old_key, None)
                for k in [k for k in shard.ctx_pool if k.startswith(old_key + "|")]:
                    try:
                        shard.ctx_pool[k]["ctx"].close()
                    except Exception:
                        pass
                    shard.ctx_pool.pop(k, None)
            browser = open_browser(p, proxy)
            shard.browser_pool[proxy_key] = browser
        ctx_key = "%s|%s" % (proxy_key, account_id or "_")
        row = shard.ctx_pool.get(ctx_key)
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
            shard.ctx_pool.pop(ctx_key, None)
        same = [k for k in shard.ctx_pool if k.startswith(proxy_key + "|")]
        if len(same) >= MAX_CTX:
            old = same[0]
            try:
                if shard.ctx_pool[old].get("page"):
                    shard.ctx_pool[old]["page"].close()
            except Exception:
                pass
            try:
                shard.ctx_pool[old]["ctx"].close()
            except Exception:
                pass
            shard.ctx_pool.pop(old, None)
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
        shard.ctx_pool[ctx_key] = {"ctx": ctx, "last": time.time(), "n": 1, "page": None, "born": time.time()}
        return browser, ctx, None, ctx_key


def open_browser(p, proxy):
    args = ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"]
    ignore = ["--enable-automation"]
    kw = {"headless": HEADLESS, "args": args, "ignore_default_args": ignore}
    launch_proxy = playwright_proxy(proxy)
    if launch_proxy:
        kw["proxy"] = launch_proxy
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
    requested = str(model or "").strip().lower()
    web_auto = requested in ("chatgpt-web-auto", "chatgpt-web")
    web_fast = requested == "chatgpt-web-fast"
    if web_auto or web_fast:
        preferred = ["Instant", "Fast", "快速响应", "快速"] if web_fast else ["Auto", "ChatGPT"]
        if click_named(page, preferred):
            time.sleep(0.12)
            return True, "Instant" if web_fast else "Auto"
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
                    if click_named(page, preferred):
                        time.sleep(0.12)
                        return True, "Instant" if web_fast else "Auto"
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
        "gpt-5.6": ["GPT-5.6", "5.6"],
        "latest": ["GPT-5.6", "5.6"],
        "gpt-5": ["GPT-5 Auto", "GPT-5"],
        "gpt-5-thinking": ["GPT-5 Thinking", "Thinking", "Sol"],
        "gpt-4o": ["GPT-4o", "4o"],
    }.get(requested, [model])
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
    ok = any(lab.lower() in actual.lower() for lab in labels) if actual else False
    return ok, actual

def is_chatgpt_image_model(model):
    return str(model or "").strip().lower() == "chatgpt-llm-image"

def run_chat(body, ctx=None):
    ctx = ctx or JobRuntimeContext(body)
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
    image_job = body.get("kind") in ("image", "edit") and is_chatgpt_image_model(body.get("model"))
    _requested_refs, ref_hashes, _reference_descs = bind_reference_hashes(ctx, images)
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
    if TEST_URL and not real and os.environ.get("RELAY_TEST_BROWSER") != "1":
        return {"ok": True, "text": "MOCK:" + prompt}
    if not state:
        return {"ok": False, "error": "没有登录态。把 state.json 放到本目录，或从平台下发 Session"}
    sel = body.get("selectors") or {}
    inp = (sel.get("input") or [])[:6]
    for fallback_input in ("#prompt-textarea", "[contenteditable='true']", "[role='textbox']", "textarea", "[data-placeholder]"):
        if fallback_input not in inp:
            inp.append(fallback_input)
    inp = inp[:6]
    send = (sel.get("send") or ["button[data-testid='send-button']", "button[aria-label='Send prompt']"])[:4]
    assistant = (sel.get("assistant") or ["div[data-message-author-role='assistant']"])[:4]
    stop = (sel.get("streamingStop") or ["button[aria-label='Stop streaming']", "button[aria-label='Stop generating']", "button[data-testid='stop-button']"])[:4]
    pack_version = body.get("selectorPackVersion") or sel.get("version") or "chatgpt-v1"
    timeout_ms = int(body.get("timeoutMs") or 90000)
    public_model = (body.get("model") or "chatgpt-web-auto").strip()
    model = "chatgpt-web-auto" if image_job else public_model
    proxy = None if TEST_URL else job_proxy(body)
    if not TEST_URL:
        ident = proxy_identity_error(body, proxy)
        if ident:
            return {"ok": False, "error": ident, "fault": "proxy"}
        if not proxy:
            return {"ok": False, "error": proxy_fail_error(body), "fault": "proxy"}
        if not socks_https_ok(proxy):
            return {"ok": False, "error": tunnel_down_error(), "fault": "proxy"}

    def first_visible(page, names):
        loc, _sel = pick_locator(page, names, min(6, len(names or [])))
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
        net = {"armed": False, "req": None, "res": None, "finished": False, "urls": set()}
        image_net = {"armed": False, "by_url": {}}
        def arm_turn_network():
            net["armed"] = True
            net["req"] = None
            net["res"] = None
            net["finished"] = False
            net["urls"] = set()
        def on_req(req):
            u = req.url or ""
            if not net["armed"] or str(getattr(req, "method", "")).upper() != "POST":
                return
            if any(x in u for x in ("/backend-api/", "/conversation")):
                net["urls"].add(u)
            if net["req"] is None and u in net["urls"]:
                net["req"] = time.time()
        def on_res(res):
            u = res.url or ""
            if net["armed"] and net["res"] is None and u in net["urls"]:
                net["res"] = time.time()
            if image_job and image_net["armed"]:
                try:
                    ct = (res.headers.get("content-type") or "").lower()
                    if "image/" not in ct or "svg" in ct:
                        return
                    if any(bad in u.lower() for bad in ("favicon", "sprite", "logo", "icon", "emoji", "avatar")):
                        return
                    raw = res.body()
                    if not image_magic_ok(raw) or result_is_reference(raw, ref_hashes):
                        return
                    w, h = image_wh(raw)
                    if w >= 64 and h >= 64:
                        image_net["by_url"][u] = (raw, ct.split(";")[0], w, h)
                except Exception:
                    pass
        def on_req_done(req):
            u = req.url or ""
            if net["armed"] and u in net["urls"]:
                net["finished"] = True
        try:
            page.on("request", on_req)
            page.on("response", on_res)
            page.on("requestfinished", on_req_done)
        except Exception:
            pass
        mark("T2")
        post_phase("opening_chatgpt", ctx)
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
            target = CHAT_URL if TEST_URL or not real else "https://chatgpt.com/?temporary-chat=true"
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
        post_phase("page_ready", ctx)
        profile = detect_profile(page)
        switched, actual = select_model(page, model)
        if not switched and not TEST_URL:
            code = "MODEL_SELECTION_UNCONFIRMED" if not actual else "MODEL_MISMATCH"
            return {"ok": False, "error": code + ": failed to select " + model, "fault": "provider", "modelActual": actual or "", "timing": marks, "profile": profile}
        if images:
            attached = attach_images(page, images)
            miss = attachment_incomplete(len(images), attached)
            if miss:
                return fail_job(ctx, miss, "provider", {"attachedReferenceCount": attached, "requestedReferenceCount": len(images), "modelActual": actual or ""})
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
        post_phase("composer_ready", ctx)
        if body.get("kind") == "canary":
            fp = page_fingerprint(page, sel)
            pst = detect_page_state(page, "chatgpt")
            composer_ok = first_visible(page, inp) is not None
            try:
                state_out = context.storage_state()
            except Exception:
                state_out = None
            return {
                "ok": pst in ("COMPOSER_READY", "AUTHENTICATED", "RESULT_READY", "GENERATING") and composer_ok,
                "text": "CANARY",
                "pageState": pst,
                "fingerprint": fp,
                "selectorPackVersion": pack_version,
                "modelActual": actual or model,
                "profile": profile,
                "timing": marks,
                "sessionState": state_out,
                "sessionBaseVersion": int(body.get("sessionVersion") or 0),
                "sessionVersion": int(body.get("sessionVersion") or 0) + 1,
            }
        image_boundary = create_generation_boundary(page, ctx, "chatgpt", prompt) if image_job else None
        if image_job:
            image_net["armed"] = True
        mark("T5")
        install_mut_observer(page, page.locator("div[data-message-author-role='assistant']").count())
        arm_turn_network()
        set_submission_state(ctx, "INPUT_READY")
        if not set_submission_state(ctx, "SUBMITTING"):
            ctx.submission_state = "INPUT_READY"
            ctx.retry_safety = "SAFE"
            return fail_job(ctx, "WORKER_TIMEOUT: submission checkpoint unavailable", "worker", {"timing": marks})
        sub = submit_prompt(page, prompt, inp, send, stop)
        mark("T6")
        if sub.get("acked"):
            set_submission_state(ctx, "SUBMITTED")
        elif sub.get("clicked") or sub.get("composer_empty") or sub.get("turn_increased"):
            set_submission_state(ctx, "SUBMISSION_UNCERTAIN")
        else:
            page, recovery_level = recover_page(page, context, 3, real)
            composer_ready(page, COMPOSER_READY_TIMEOUT)
            switched, actual = select_model(page, model)
            install_mut_observer(page, page.locator("div[data-message-author-role='assistant']").count())
            arm_turn_network()
            if not set_submission_state(ctx, "SUBMITTING"):
                ctx.submission_state = "INPUT_READY"
                ctx.retry_safety = "SAFE"
                return fail_job(ctx, "WORKER_TIMEOUT: submission checkpoint unavailable", "worker", {"recoveryLevel": recovery_level, "timing": marks})
            sub = submit_prompt(page, prompt, inp, send, stop)
            if sub.get("acked"):
                set_submission_state(ctx, "SUBMITTED")
            elif sub.get("clicked") or sub.get("composer_empty") or sub.get("turn_increased"):
                set_submission_state(ctx, "SUBMISSION_UNCERTAIN")
            elif not TEST_URL:
                try:
                    print("SEND_NOT_ACKED url", page.url, "send_on", send_button_enabled(page), "composer", composer_text(page)[:80], flush=True)
                except Exception:
                    pass
                return fail_job(ctx, "SEND_NOT_ACKED: message did not enter conversation", "provider", {"recoveryLevel": recovery_level, "timing": marks})
        mark("T7")
        post_phase("generating", ctx)
        if ctx and ctx.submission_state == "SUBMITTED":
            set_submission_state(ctx, "GENERATING")
        if image_job:
            def complete_chatgpt_image(raw, mime, width, height, confidence="VERIFIED"):
                mark("T8")
                set_submission_state(ctx, "RESULT_DETECTED")
                data_url = raw_to_data_url(raw, mime)
                if not data_url:
                    return None
                set_submission_state(ctx, "RESULT_VALIDATED")
                mark("T9")
                try:
                    state_out = context.storage_state()
                except Exception:
                    state_out = None
                mark("T10")
                return {
                    "ok": True,
                    "text": "IMAGE",
                    "url": data_url,
                    "urls": [data_url],
                    "resultConfidences": [confidence or "VERIFIED"],
                    "pageState": "RESULT_READY",
                    "modelActual": actual or "ChatGPT",
                    "backendMode": "web_account",
                    "selectorPackVersion": pack_version,
                    "actualWidth": width,
                    "actualHeight": height,
                    "sessionState": state_out,
                    "sessionBaseVersion": int(body.get("sessionVersion") or 0),
                    "sessionVersion": int(body.get("sessionVersion") or 0) + 1,
                    "timing": {"marks": marks, "generation_ms": marks.get("T9", 0) - marks.get("T6", 0), "total_ms": marks.get("T10", 0)},
                    "profile": profile,
                    "recoveryLevel": recovery_level,
                }
            deadline = time.time() + max(45, min(300, timeout_ms / 1000.0 - 12))
            final_text = ""
            while time.time() < deadline:
                pst = detect_page_state(page, "chatgpt")
                if pst in ("LOGIN_REQUIRED", "CHALLENGE", "RATE_LIMITED", "ACCOUNT_RESTRICTED"):
                    err, fault = page_state_error(pst, False, "chatgpt")
                    return fail_job(ctx, err, fault, {"pageState": pst, "modelActual": actual or "ChatGPT", "timing": marks})
                downloaded = download_chatgpt_image_action(page)
                if downloaded is not None:
                    raw, mime, width, height = downloaded
                    if image_magic_ok(raw) and not result_is_reference(raw, ref_hashes) and sha256_hex(raw) not in set(ctx.historical_hashes or []):
                        completed = complete_chatgpt_image(raw, mime, width, height, "VERIFIED")
                        if completed:
                            return completed
                located_raw = collect_result_candidates(page, image_boundary, "chatgpt")
                captured_urls = set(image_net["by_url"].keys())
                upgraded_captures = set(upgrade_cdn_url(url) for url in captured_urls)
                for candidate in located_raw:
                    src = candidate.get("src") or ""
                    candidate["networkCaptured"] = bool(src in captured_urls or upgrade_cdn_url(src) in upgraded_captures)
                located = pick_accepted_candidates(located_raw, 1)
                for candidate in located:
                    src = candidate.get("src") or ""
                    cached = image_net["by_url"].get(src)
                    if cached is None:
                        full = upgrade_cdn_url(src)
                        for captured_url, captured in image_net["by_url"].items():
                            if upgrade_cdn_url(captured_url) == full:
                                cached = captured
                                break
                    if cached is not None:
                        raw, mime, width, height = cached
                    else:
                        data_url, _download_error = download_page_image(page, context, src)
                        if not data_url or "," not in data_url:
                            continue
                        try:
                            header, encoded = data_url.split(",", 1)
                            raw = base64.b64decode(encoded)
                            mime = header[5:].split(";")[0] if header.startswith("data:") else "image/png"
                            width, height = image_wh(raw)
                        except Exception:
                            continue
                    if not image_magic_ok(raw) or result_is_reference(raw, ref_hashes):
                        continue
                    if sha256_hex(raw) in set(ctx.historical_hashes or []):
                        continue
                    if width < 64 or height < 64:
                        continue
                    completed = complete_chatgpt_image(raw, mime, width, height, candidate.get("confidence") or "HIGH")
                    if completed:
                        return completed
                current_text = read_assistant_full(page)
                if usable_assistant_text(current_text):
                    final_text = current_text
                time.sleep(0.35)
            if ctx and ctx.submission_state in POST_SUBMIT_STATES:
                set_submission_state(ctx, "RESULT_UNCERTAIN")
            suffix = ": assistant returned text without a downloadable image" if final_text else ": timed out waiting for a generated image"
            return fail_job(ctx, "CHATGPT_IMAGE_NOT_FOUND" + suffix, "provider", {
                "pageState": detect_page_state(page, "chatgpt"),
                "modelActual": actual or "ChatGPT",
                "timing": marks,
                "profile": profile,
                "recoveryLevel": recovery_level,
            })
        want_fast = "thinking" not in (model or "").lower()
        has_images = bool(images)
        first_wait = (40 if has_images else 18) if want_fast else min(120, timeout_ms / 1000.0)
        deadline = time.time() + ((75 if has_images else 45) if want_fast else timeout_ms / 1000.0)
        token_deadline = time.time() + first_wait
        text = ""
        first_delta = False
        stable_ms = max(chat_stable_ms(), 2000) if has_images else chat_stable_ms()
        det = AssistantCompletionDetector(stable_ms=stable_ms, confirm_ms=chat_confirm_ms(), stop_stable_ms=chat_stop_stable_ms())
        det.on_submit(time.time())
        while time.time() < deadline:
            try:
                det.on_stop(stop_generating_visible(page, stop), time.time())
            except Exception:
                det.on_stop(False, time.time())
            if net.get("req"):
                det.on_network_request()
            if net.get("res"):
                det.on_network_response()
            if net.get("finished"):
                det.on_network_finished(time.time())
            try:
                if last_assistant_complete_signal(page):
                    det.on_semantic_complete(time.time())
            except Exception:
                pass
            drained = drain_deltas(page)
            full = (drained.get("full") or "").strip()
            if usable_assistant_text(full):
                det.on_assistant_node(time.time())
                piece = "".join(drained.get("deltas") or [])
                if piece:
                    if not first_delta:
                        first_delta = True
                        mark("T8")
                    post_chunk(piece, "streaming", ctx)
                elif not text:
                    if not first_delta:
                        first_delta = True
                        mark("T8")
                    post_chunk(full, "streaming", ctx)
                det.on_delta(full, time.time())
                text = full
            st = det.tick(time.time())
            if st == det.CONFIRMED_COMPLETE:
                break
            if (not first_delta) and time.time() > token_deadline:
                break
            time.sleep(0.06)
        mark("T9")
        final_dom = read_assistant_full(page)
        if usable_assistant_text(final_dom) and final_dom != text:
            det.final_text_replaced = True
            if final_dom.startswith(text or ""):
                gap = final_dom[len(text or ""):]
                if gap:
                    post_chunk(gap, "streaming", ctx)
            text = final_dom
            det.on_delta(final_dom, time.time())
            reconfirm_deadline = min(
                deadline,
                time.time() + (stable_ms + chat_confirm_ms() + 1000) / 1000.0,
            )
            while time.time() < reconfirm_deadline and det.state != det.CONFIRMED_COMPLETE:
                latest = read_assistant_full(page)
                if usable_assistant_text(latest) and latest != text:
                    if latest.startswith(text or ""):
                        gap = latest[len(text or ""):]
                        if gap:
                            post_chunk(gap, "streaming", ctx)
                    text = latest
                    det.on_delta(latest, time.time())
                det.on_stop(stop_generating_visible(page, stop), time.time())
                if last_assistant_complete_signal(page):
                    det.on_semantic_complete(time.time())
                det.tick(time.time())
                time.sleep(0.06)
        chat_obs = det.report(text)
        print("CHAT_COMPLETION", json.dumps(chat_obs, ensure_ascii=False), flush=True)
        if det.very_short_completion:
            print("CHAT_WARN very_short_completion len", len(text or ""), flush=True)
        if det.state != det.CONFIRMED_COMPLETE:
            pst = detect_page_state(page, "chatgpt")
            extra = {"pageState": pst, "timing": marks, "profile": profile, "recoveryLevel": recovery_level, "chatCompletion": chat_obs}
            if usable_assistant_text(text):
                extra["text"] = text
                if ctx:
                    set_submission_state(ctx, "RESULT_UNCERTAIN")
                return fail_job(ctx, "RESULT_UNCERTAIN: assistant stream ended without confirmed completion", "provider", extra)
            if ctx and ctx.submission_state in POST_SUBMIT_STATES:
                set_submission_state(ctx, "RESULT_UNCERTAIN")
                return fail_job(ctx, "RESULT_UNCERTAIN: TIMEOUT empty assistant after submit", "provider", extra)
            return fail_job(ctx, "TIMEOUT: empty assistant", "provider", extra)
        if ctx:
            set_submission_state(ctx, "RESULT_VALIDATED")
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
            "chat_stop_seen": bool(chat_obs.get("chat_stop_seen")),
            "chat_completion_signal": chat_obs.get("chat_completion_signal") or "",
            "chat_stable_ms": chat_obs.get("chat_stable_ms") or 0,
            "chat_final_dom_length": len(text or ""),
            "chat_streamed_length": chat_obs.get("chat_streamed_length") or 0,
            "chat_final_text_replaced": bool(chat_obs.get("chat_final_text_replaced")),
            "chat_premature_guard_triggered": bool(chat_obs.get("chat_premature_guard_triggered")),
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
            "chatCompletion": chat_obs,
            "profile": profile,
            "recoveryLevel": recovery_level,
        }

    if pool_enabled():
        browser, context, page, ctx_key = get_pooled_context(proxy, state, body.get("accountId"))
        if page is None:
            page = context.new_page()
        try:
            result = run_on(page, context, False)
            remember_page(ctx_key, page)
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
            self.wfile.write(json.dumps({
                "ok": True,
                "proxy": proxy,
                "mode": "test" if TEST_URL else "live",
                "draining": DRAINING,
                "active": ACTIVE,
                "browsers": shard_browser_count(),
                "contexts": shard_context_count(),
                "shards": len(SHARDS),
                "shardQueues": shard_queue_depths(),
            }).encode("utf-8"))
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
            body["platform"] = "chatgpt" if is_chatgpt_image_model(model) else ("leonardo" if is_leonardo_model(model) else "gemini")
            body["kind"] = "edit" if self.path == "/v1/images/edits" or body.get("images") or body.get("image") or body.get("image_url") else "image"
        try:
            result = exec_job(body)
        except Exception as e:
            result = {"ok": False, "error": str(e)[:400]}
        self.send_response(200 if result.get("ok") else 500)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))

def inspection_gateway(ctx, method="GET", query="", payload=None, raw=None, content_type="application/json"):
    gw = (os.environ.get("RELAY_GATEWAY") or "").rstrip("/")
    token = os.environ.get("RELAY_TOKEN") or ""
    iid = str((payload or {}).get("inspectionId") if isinstance(payload, dict) else "") or str(getattr(ctx, "inspection_id", "") or "")
    if not iid:
        iid = str(getattr(ctx, "job_id", "") or "")
    if not (gw and token and iid):
        return None
    try:
        import urllib.request, urllib.parse
        url = gw + "/api/worker/account-inspections"
        if method == "GET":
            url += "?" + urllib.parse.urlencode({"id": iid, **(query or {})})
            data = None
        elif raw is not None:
            data = raw
        else:
            body = dict(payload or {})
            body.pop("inspectionId", None)
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": content_type,
                "X-Inspection-Id": iid,
            },
            method=method,
        )
        response = urllib.request.urlopen(req, timeout=12).read()
        return json.loads(response.decode("utf-8") or "{}")
    except Exception as e:
        print("inspection gateway fail", method, str(e)[:120], flush=True)
        return None

def inspection_command(page, command, mode):
    if not isinstance(command, dict):
        return False
    kind = str(command.get("type") or "")
    if mode == "view" and kind not in ("scroll", "reload", "back", "forward", "close"):
        return False
    try:
        if kind == "click":
            x = max(0, min(1365, float(command.get("x") or 0)))
            y = max(0, min(900, float(command.get("y") or 0)))
            page.mouse.click(x, y)
        elif kind == "type":
            page.keyboard.insert_text(str(command.get("text") or "")[:4000])
        elif kind == "key":
            key = str(command.get("key") or "")
            if key not in ("Enter", "Escape", "Tab", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"):
                return False
            page.keyboard.press(key)
        elif kind == "scroll":
            delta = max(-2400, min(2400, int(command.get("deltaY") or 0)))
            page.mouse.wheel(0, delta)
        elif kind == "reload":
            page.reload(wait_until="domcontentloaded", timeout=25000)
        elif kind == "back":
            page.go_back(wait_until="domcontentloaded", timeout=25000)
        elif kind == "forward":
            page.go_forward(wait_until="domcontentloaded", timeout=25000)
        elif kind == "close":
            return True
        else:
            return False
        return kind == "close"
    except Exception as e:
        print("inspection command fail", kind, str(e)[:120], flush=True)
        return False

def run_account_inspection(body, ctx=None):
    ctx = ctx or JobRuntimeContext(body)
    ctx.inspection_id = str(body.get("inspectionId") or "")
    if not ctx.inspection_id:
        return {"ok": False, "error": "INSPECTION_ID_REQUIRED", "fault": "worker"}
    proxy = job_proxy(body)
    if proxy is None:
        return {"ok": False, "error": proxy_fail_error(body, body.get("platform") == "leonardo"), "fault": "proxy"}
    state = body.get("storageState") or {}
    if not (state.get("cookies") or []):
        return {"ok": False, "error": "SESSION_INVALID: inspection missing cookies", "fault": "account"}
    browser, context, page, ctx_key = get_pooled_context(proxy, state, body.get("accountId"))
    if page is None or page.is_closed():
        page = context.new_page()
        remember_page(ctx_key, page)
        target = "https://chatgpt.com/?temporary-chat=true"
        if body.get("platform") == "gemini":
            target = "https://gemini.google.com/app"
        elif body.get("platform") == "leonardo":
            target = "https://app.leonardo.ai/generate"
        page.goto(target, wait_until="domcontentloaded", timeout=30000)
    arm_page(page)
    observed = exit_ip(context)
    frame_seq = 0
    command_seq = 0
    mode = "view"
    inspection_gateway(ctx, "POST", payload={
        "inspectionId": ctx.inspection_id,
        "status": "active",
        "observedIp": observed,
        "pageUrl": page.url or "",
        "pageTitle": page.title() if page else "",
        "viewportWidth": 1365,
        "viewportHeight": 900,
    })
    deadline = time.time() + min(1800, max(30, int(body.get("timeoutMs") or 1800000) / 1000 - 10))
    close_reason = "timeout"
    try:
        while time.time() < deadline:
            try:
                raw = page.screenshot(type="jpeg", quality=58, timeout=10000)
                uploaded = inspection_gateway(ctx, "POST", raw=raw, content_type="image/jpeg")
                if uploaded and uploaded.get("frameSeq"):
                    frame_seq = int(uploaded.get("frameSeq") or frame_seq)
            except Exception as e:
                print("inspection frame fail", str(e)[:120], flush=True)
            polled = inspection_gateway(ctx, "GET", query={"afterSeq": command_seq}) or {}
            mode = str(polled.get("mode") or mode)
            next_seq = int(polled.get("commandSeq") or command_seq)
            command = polled.get("command") if next_seq > command_seq else None
            if command:
                should_close = inspection_command(page, command, mode)
                command_seq = next_seq
                if should_close:
                    close_reason = "closed_by_admin"
                    break
            if polled.get("close"):
                close_reason = "closed_by_admin"
                break
            inspection_gateway(ctx, "POST", payload={
                "inspectionId": ctx.inspection_id,
                "status": "active",
                "observedIp": observed,
                "pageUrl": page.url or "",
                "pageTitle": page.title() if page else "",
                "viewportWidth": 1365,
                "viewportHeight": 900,
                "frameSeq": frame_seq,
            })
            time.sleep(0.65)
    except Exception as e:
        inspection_gateway(ctx, "POST", payload={"inspectionId": ctx.inspection_id, "status": "failed", "closeReason": str(e)[:500]})
        return {"ok": False, "error": "INSPECTION_FAILED: %s" % str(e)[:240], "fault": "worker"}
    try:
        state_out = context.storage_state()
    except Exception:
        state_out = None
    pst = detect_page_state(page, body.get("platform") or "chatgpt")
    actual = body.get("model") or ""
    inspection_gateway(ctx, "POST", payload={
        "inspectionId": ctx.inspection_id,
        "status": "closed",
        "closeReason": close_reason,
        "observedIp": observed,
        "pageUrl": page.url or "",
        "pageTitle": page.title() if page else "",
    })
    return {
        "ok": True,
        "text": "INSPECTION_CLOSED",
        "pageState": pst,
        "modelActual": actual,
        "sessionState": state_out,
        "sessionBaseVersion": int(body.get("sessionVersion") or 0),
        "sessionVersion": int(body.get("sessionVersion") or 0) + 1,
    }

def exec_job(body):
    shard = pick_shard(body)
    if shard.thread is None or threading.current_thread() is shard.thread:
        return exec_job_run(body)
    ev = threading.Event()
    box = {"ev": ev, "result": None}
    shard.q.put((body, box))
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
    ctx = JobRuntimeContext(body)
    register_job(ctx)
    aid = ctx.account_id
    SEM.acquire()
    account_lock(aid).acquire()
    ACTIVE += 1
    try:
        if body.get("kind") == "inspection":
            result = run_account_inspection(body, ctx)
        elif body.get("platform") == "chatgpt" and body.get("kind") in ("image", "edit") and is_chatgpt_image_model(body.get("model")):
            result = run_chat(body, ctx)
        elif body.get("platform") in ("gemini", "image", "leonardo") or body.get("kind") in ("image", "edit"):
            if body.get("platform") == "leonardo" or is_leonardo_model(body.get("model")):
                result = run_leonardo(body, ctx)
            else:
                result = run_image(body, ctx)
        else:
            result = run_chat(body, ctx)
        return attach_runtime(ctx, result)
    except Exception as e:
        if body.get("kind") == "inspection":
            ctx.inspection_id = str(body.get("inspectionId") or "")
            inspection_gateway(ctx, "POST", payload={
                "inspectionId": ctx.inspection_id,
                "status": "failed",
                "closeReason": str(e)[:500],
            })
        return attach_runtime(ctx, {"ok": False, "error": "WORKER_CRASH: %s" % str(e)[:240], "fault": "worker"})
    finally:
        ACTIVE -= 1
        account_lock(aid).release()
        SEM.release()
        unregister_job(ctx)

def run_image(body, ctx=None):
    ctx = ctx or JobRuntimeContext(body)
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
    ident = proxy_identity_error(body, proxy)
    if ident:
        return {"ok": False, "error": ident, "fault": "proxy"}
    if not proxy:
        return {"ok": False, "error": proxy_fail_error(body), "fault": "proxy"}
    if not TEST_URL and not socks_https_ok(proxy):
        return {"ok": False, "error": tunnel_down_error(), "fault": "proxy"}
    sel = body.get("selectors") or {}
    inp = (sel.get("input") or ["div.ql-editor", "div[contenteditable='true']", "rich-textarea"])[:4]
    send = (sel.get("send") or ["button[aria-label*='Send']", "button[aria-label*='发送']"])[:4]
    pack_version = body.get("selectorPackVersion") or sel.get("version") or "gemini-v1"

    def run_image_on(page, context):
        ready, warm_state = ensure_gemini_ready(page)
        pst = detect_page_state(page, "gemini")
        if not ready:
            return fail_job(ctx, "PROVIDER_DOM_CHANGED: Gemini page not WARM_IDLE after cleanup", "provider", {"pageState": pst, "runtimeState": warm_state})
        if warm_state == "INVALID" or pst in ("LOGIN_REQUIRED", "CHALLENGE", "RATE_LIMITED", "ACCOUNT_RESTRICTED"):
            err, fault = page_state_error(pst if pst in ("LOGIN_REQUIRED", "CHALLENGE", "RATE_LIMITED", "ACCOUNT_RESTRICTED") else "LOGIN_REQUIRED", False)
            return {"ok": False, "error": err, "fault": fault, "pageState": pst, "runtimeState": warm_state}
        attach_images(page, images)
        requested, ref_hashes, _descs = bind_reference_hashes(ctx, images)
        if requested:
            attached = count_gemini_refs(page)
            miss = attachment_incomplete(requested, attached)
            if miss:
                return fail_job(ctx, miss, "provider", {"pageState": detect_page_state(page, "gemini"), "attachedReferenceCount": attached, "requestedReferenceCount": requested})
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
            return fail_job(ctx, "PROVIDER_DOM_CHANGED: cannot fill composer", "provider")
        apply_gemini_aspect(page, body.get("aspect") or size_to_aspect(body.get("size") or "1:1"))
        boundary = create_generation_boundary(page, ctx, "gemini", prompt)
        baseline = boundary.get("baseline_asset_urls") or snapshot_image_srcs(page)
        send_btn, _ = pick_locator(page, send, 4)
        if not set_submission_state(ctx, "SUBMITTING"):
            ctx.submission_state = "INPUT_READY"
            ctx.retry_safety = "SAFE"
            return fail_job(ctx, "WORKER_TIMEOUT: submission checkpoint unavailable", "worker")
        click_send(page, send_btn)
        set_submission_state(ctx, "SUBMITTED")
        set_submission_state(ctx, "GENERATING")
        deadline = time.time() + int(body.get("timeoutMs") or 90000) / 1000
        url = ""
        conf = ""
        while time.time() < deadline:
            picked = pick_accepted_candidates(gemini_result_locator(page, boundary), 1)
            if picked:
                url = picked[0].get("src") or ""
                conf = picked[0].get("confidence") or ""
                if url:
                    set_submission_state(ctx, "RESULT_DETECTED")
                    break
            time.sleep(0.6)
        if not url:
            set_submission_state(ctx, "RESULT_UNCERTAIN")
            return fail_job(ctx, "RESULT_UNCERTAIN: IMAGE_CONFIDENCE_TOO_LOW no HIGH/VERIFIED result", "provider", {"pageState": detect_page_state(page, "gemini")})
        if url.startswith("http"):
            try:
                resp = context.request.get(url, timeout=20000)
                raw = resp.body()
                mime = (resp.headers.get("content-type") or "image/png").split(";")[0]
                if "svg" in mime:
                    return {"ok": False, "error": "IMAGE_NOT_FOUND: svg placeholder rejected", "fault": "provider"}
                if not raw or len(raw) < 2048:
                    return {"ok": False, "error": "IMAGE_NOT_FOUND: image too small", "fault": "provider"}
                if result_is_reference(raw, ref_hashes):
                    return fail_job(ctx, "RESULT_IS_REFERENCE_IMAGE", "provider", {"pageState": detect_page_state(page, "gemini")})
                if sha256_hex(raw) in set(ctx.historical_hashes or []):
                    return fail_job(ctx, "IMAGE_NOT_FOUND: historical asset returned", "provider", {"pageState": detect_page_state(page, "gemini")})
                url = "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode())
            except Exception:
                return {"ok": False, "error": "IMAGE_NOT_FOUND: download failed", "fault": "provider"}
        if url.startswith("data:image/svg"):
            return {"ok": False, "error": "IMAGE_NOT_FOUND: svg placeholder rejected", "fault": "provider"}
        if url.startswith("data:image") and "," in url:
            try:
                raw = base64.b64decode(url.split(",", 1)[1])
                if result_is_reference(raw, ref_hashes):
                    return fail_job(ctx, "RESULT_IS_REFERENCE_IMAGE", "provider", {"pageState": detect_page_state(page, "gemini")})
                if sha256_hex(raw) in set(ctx.historical_hashes or []):
                    return fail_job(ctx, "IMAGE_NOT_FOUND: historical asset returned", "provider", {"pageState": detect_page_state(page, "gemini")})
            except Exception:
                pass
        try:
            state_out = context.storage_state()
        except Exception:
            state_out = None
        cleanup_gemini(page)
        set_submission_state(ctx, "RESULT_VALIDATED")
        return {
            "ok": True,
            "url": url,
            "sessionState": state_out,
            "sessionBaseVersion": int(body.get("sessionVersion") or 0),
            "sessionVersion": int(body.get("sessionVersion") or 0) + 1,
            "selectorPackVersion": pack_version,
            "pageState": "WARM_IDLE",
            "resultConfidence": conf or "HIGH",
            "resultConfidences": [conf or "HIGH"],
            "runtimeState": "WARM_IDLE",
            "warmStats": dict(WARM_STATS),
        }

    if pool_enabled():
        browser, context, page, ctx_key = get_pooled_context(proxy, state, body.get("accountId"))
        if page is None:
            page = context.new_page()
        try:
            result = run_image_on(page, context)
            remember_page(ctx_key, page)
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
    area = max(1, int(w or 0)) * max(1, int(h or 0))
    if gpt:
        if area >= 6000000:
            return "Large", 2880
        if area >= 2000000:
            return "Medium", 2048
        return "Small", 1024
    if area >= 10000000:
        return "Large", 4096
    if area >= 2000000:
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
              const linesOf = (el) => ((el.innerText || '').trim().split('\\\\n').map((s) => s.trim()).filter(Boolean));
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
        slider_steps = {"21:9": 0, "16:9": 1, "3:2": 2, "4:3": 3, "5:4": 4, "1:1": 5, "4:5": 6, "3:4": 7, "2:3": 8, "9:16": 9}
        if str(how).startswith("custom-open") and aspect in slider_steps:
            try:
                slider = page.get_by_role("slider", name="Output Dimensions - Aspect Ratio").last
                slider.press("Home", timeout=1800)
                for _ in range(slider_steps[aspect]):
                    slider.press("ArrowRight", timeout=1800)
                    page.wait_for_timeout(90)
                page.wait_for_timeout(350)
                return str(how) + "+slider:" + str(slider_steps[aspect])
            except Exception as e:
                how = str(how) + "+slider-err:" + str(e)[:80]
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
                  return 'preset:' + ((hit.innerText || '').trim().split('\\\\n')[0]);
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
              const want = norm(wantX);
              const labels = [...document.querySelectorAll('div,p,span,label,h2,h3,h4')].filter(vis);
              const dimensionLabel = labels.find((e) => {
                const first = ((e.innerText || '').split('\\\\n')[0] || '').trim();
                return /^image dimensions$/i.test(first);
              });
              let scope = dimensionLabel ? (dimensionLabel.parentElement || dimensionLabel) : document.body;
              if (dimensionLabel) {
                let node = dimensionLabel.parentElement;
                for (let i = 0; node && i < 5; i++, node = node.parentElement) {
                  const text = norm(node.innerText || '');
                  const controls = [...node.querySelectorAll('button, [role=button], [role=radio], [role=option]')].filter(vis);
                  if (controls.length > 0 && (text.indexOf(want) >= 0 || /small|medium|large|1k|2k|4k/.test(text))) {
                    scope = node;
                    break;
                  }
                }
              }
              const buttons = [...scope.querySelectorAll('button, [role=button], [role=radio], [role=option]')].filter(vis);
              const squarePreset = (t) => /^(1024x1024|2048x2048|4096x4096|2880x2880)$/.test(t);
              const px = buttons.find((e) => {
                const t = norm(e.innerText || '');
                const a = norm(e.getAttribute('aria-label') || '');
                const first = norm((e.innerText || '').split('\\\\n')[0]);
                if (aspect !== '1:1' && (squarePreset(first) || squarePreset(t))) return false;
                return t.indexOf(want) >= 0 || a.indexOf(want) >= 0;
              });
              if (click(px)) return 'px';
              const tbtn = buttons.find((b) => {
                const raw = (b.innerText || '').trim();
                const first = raw.split('\\\\n')[0].trim();
                const t = norm(raw);
                if (!(first === tier || first.toLowerCase() === tier.toLowerCase() || first.toUpperCase() === k)) return false;
                if (aspect !== '1:1' && (squarePreset(t) || t.indexOf('1024x1024') >= 0 || t.indexOf('2048x2048') >= 0)) return false;
                if (/\\d{3,5}x\\d{3,5}/.test(t) && t.indexOf(want) < 0) return false;
                return true;
              });
              if (click(tbtn)) return 'tier';
              return dimensionLabel ? 'dimension-miss' : 'dimension-label-miss';
            }""",
            {"aspect": aspect, "tier": tier, "k": k, "w": w, "h": h},
        )
    except Exception:
        dim = "err"
    return dim

def set_gpt_resolution_query(page, aspect, tier):
    try:
        from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
        current = str(page.url or "")
        parsed = urlsplit(current)
        if parsed.hostname != "app.leonardo.ai" or "/generate" not in parsed.path:
            return "query-skip"
        params = dict(parse_qsl(parsed.query, keep_blank_values=True))
        wanted_size = str(tier or "Small").upper()
        aspect_values = {
            "3:2": "3:2-slider-only",
            "4:3": "4:3-twitter",
            "3:4": "3:4-slider-only",
            "9:16": "9:16-mobile",
            "4:5": "4:5-instagram",
            "5:4": "5:4-slider-only",
            "21:9": "21:9-ultrawide-film",
        }
        wanted_aspect = aspect_values.get(str(aspect), str(aspect))
        if params.get("aspectRatio") == wanted_aspect and params.get("size") == wanted_size:
            return "query-already"
        params["aspectRatio"] = wanted_aspect
        params["size"] = wanted_size
        target = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(params), parsed.fragment))
        page.goto(target, wait_until="domcontentloaded", timeout=25000)
        page.wait_for_timeout(900)
        return "query:" + wanted_size
    except Exception as e:
        return "query-error:" + str(e)[:80]

def read_displayed_size(page):
    try:
        pair = page.evaluate("""() => {
          const lab = [...document.querySelectorAll('div,p,span,label,h2,h3,h4')].find((e) => {
            const t = (e.innerText || '').split('\\\\n')[0] || '';
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

def wait_displayed_size(page, timeout_ms=12000):
    deadline = time.time() + max(0.5, float(timeout_ms or 0) / 1000.0)
    shown_w, shown_h = 0, 0
    while time.time() < deadline:
        shown_w, shown_h = read_displayed_size(page)
        if shown_w > 0 and shown_h > 0:
            return shown_w, shown_h
        try:
            page.wait_for_timeout(250)
        except Exception:
            time.sleep(0.25)
    return read_displayed_size(page)

def close_leonardo_drawers(page):
    closed = 0
    for _ in range(4):
        try:
            hit = page.evaluate("""() => {
              const vis = (el) => {
                const r = el.getBoundingClientRect();
                const st = getComputedStyle(el);
                return r.width > 4 && r.height > 4 && st.visibility !== 'hidden' && st.display !== 'none';
              };
              const drawers = [...document.querySelectorAll('[data-slot="drawer-content"]')].filter(vis);
              const drawer = drawers[drawers.length - 1];
              if (!drawer) return false;
              const close = drawer.querySelector('button[data-slot="drawer-close"], [data-slot="drawer-close"]');
              if (!close) return false;
              close.click();
              return true;
            }""")
        except Exception:
            hit = False
        if not hit:
            break
        closed += 1
        try:
            page.wait_for_timeout(180)
        except Exception:
            time.sleep(0.18)
    return closed

def apply_image_size(page, want_size, aspect=None, tier=None, gpt=False):
    aspect = (aspect or size_to_aspect(want_size) or "1:1").strip()
    w, h = parse_size_wh(want_size)
    if not tier:
        tier, _px = size_tier(w, h, gpt)
    k = "4K" if str(tier).lower() == "large" else ("2K" if str(tier).lower() == "medium" else "1K")
    opened = click_leonardo_aspect(page, aspect)
    closed = close_leonardo_drawers(page)
    if closed:
        opened = str(opened) + "+closed:" + str(closed)
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
    query = ""
    shown_tier, _shown_px = size_tier(shown_w, shown_h, gpt)
    if gpt and (not aspect_match(shown_w, shown_h, aspect) or str(shown_tier).lower() != str(tier).lower()):
        if count_leonardo_refs(page) == 0:
            query = set_gpt_resolution_query(page, aspect, tier)
            shown_w, shown_h = wait_displayed_size(page, 12000)
    print("image size want=%s aspect=%s tier=%s %dx%d open=%s dim=%s query=%s shown=%dx%d url=%s" % (want_size, aspect, tier, w, h, opened, dim, query, shown_w, shown_h, page.url), flush=True)
    try:
        page.keyboard.press("Escape")
    except Exception:
        pass
    return w, h, aspect, tier

def confirm_leonardo_image_size(page, want_size, aspect=None, tier=None, gpt=False, attempts=2):
    aspect = (aspect or size_to_aspect(want_size) or "1:1").strip()
    want_w, want_h = parse_size_wh(want_size)
    shown_w, shown_h = 0, 0
    for _ in range(max(1, int(attempts or 1))):
        apply_image_size(page, want_size, aspect, tier, gpt)
        shown_w, shown_h = read_displayed_size(page)
        if shown_w == want_w and shown_h == want_h and aspect_match(shown_w, shown_h, aspect):
            return True, shown_w, shown_h, ""
        shown_tier, _shown_px = size_tier(shown_w, shown_h, gpt)
        if gpt and aspect_match(shown_w, shown_h, aspect) and str(shown_tier).lower() == str(tier or "").lower():
            return True, shown_w, shown_h, ""
    if shown_w <= 0 or shown_h <= 0:
        error = "LEONARDO_DOM_CHANGED: Image Dimensions unreadable, want %s %s" % (aspect, want_size)
    else:
        error = "LEONARDO_DOM_CHANGED: Image Dimensions stayed %dx%d, want %s %s" % (shown_w, shown_h, aspect, want_size)
    return False, shown_w, shown_h, error

def click_leonardo_model(page, label):
    label = str(label or "").strip()
    if not label:
        return ""
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    try:
        trigger = page.locator('[data-testid="image-generation-sidebar-container"] [data-testid="model-selector-trigger"]').first
        current = re.sub(r"^model\\s+", "", " ".join((trigger.inner_text() or "").split()), flags=re.I).strip()
        if current.lower() == label.lower():
            return "already:" + label
    except Exception:
        pass

    def click_exact_option():
        try:
            return page.evaluate(
                """(args) => {
                  const want = String(args.want || '');
                  const slug = String(args.slug || '');
                  const vis = (el) => {
                    const r = el.getBoundingClientRect();
                    const st = getComputedStyle(el);
                    return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < window.innerHeight && st.visibility !== 'hidden' && st.display !== 'none';
                  };
                  const selector = '[role=menuitem], [role=option], [data-slot=dropdown-menu-item], [data-radix-collection-item], [role=listbox] button, [role=menu] button, [data-slot=drawer-content] button[data-testid]';
                  const hits = [...document.querySelectorAll(selector)].filter((el) => {
                    if (!vis(el) || el.getAttribute('data-testid') === 'model-selector-trigger') return false;
                    if (slug && el.getAttribute('data-testid') === slug) return true;
                    const lines = (el.innerText || '').split('\\\\n').map((line) => line.trim()).filter(Boolean);
                    return lines.includes(want) || (el.innerText || '').trim() === want;
                  });
                  const hit = hits[hits.length - 1];
                  if (!hit) return '';
                  hit.click();
                  return (hit.innerText || '').trim().split('\\\\n').filter(Boolean).pop() || want;
                }""",
                {"want": label, "slug": slug},
            ) or ""
        except Exception:
            return ""

    clicked = click_exact_option()
    if clicked:
        return "exact:" + str(clicked)
    for spec in ('[data-testid="image-generation-sidebar-container"] [data-testid="model-selector-trigger"]', '[data-testid="model-selector-trigger"]', 'button:has-text("Model")', '[aria-label="Model"]', '[aria-label^=Model]'):
        try:
            loc = page.locator(spec).first
            if loc.count() == 0:
                continue
            loc.click(timeout=1400, force=True)
        except Exception:
            continue
        for _ in range(12):
            page.wait_for_timeout(250)
            clicked = click_exact_option()
            if clicked:
                return "open+exact:" + str(clicked)
        close_leonardo_drawers(page)
    return ""

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
              let hit = nodes.find((e) => vis(e) && ((e.innerText || '').trim().split('\\\\n')[0] === aspect || (e.getAttribute('aria-label') || '').trim() === aspect));
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
              const hit = nodes.find((e) => ((e.innerText || '').trim().split('\\\\n')[0] === aspect) || ((e.getAttribute('aria-label') || '').indexOf(aspect) >= 0));
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
        if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            chunk = raw[12:16]
            if chunk == b"VP8X" and len(raw) >= 30:
                return 1 + int.from_bytes(raw[24:27], "little"), 1 + int.from_bytes(raw[27:30], "little")
            if chunk == b"VP8 " and len(raw) >= 30 and raw[23:26] == b"\\x9d\\x01\\x2a":
                return int.from_bytes(raw[26:28], "little") & 0x3fff, int.from_bytes(raw[28:30], "little") & 0x3fff
            if chunk == b"VP8L" and len(raw) >= 25 and raw[20] == 0x2f:
                bits = int.from_bytes(raw[21:25], "little")
                return (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1
    except Exception:
        return 0, 0
    return 0, 0

def upgrade_cdn_url(url):
    u = str(url or "")
    if not u.startswith("http"):
        return u
    u = re.sub(r"([?&])(w|width|h|height|dpr|q|quality|fm|fit)=[^&]*", r"\\1", u)
    u = u.replace("?&", "?")
    u = re.sub(r"&+", "&", u)
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
        best = None
        seen = set()
        for candidate in (url, upgrade_cdn_url(url)):
            if not candidate:
                continue
            if candidate in seen:
                continue
            seen.add(candidate)
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
                w, h = image_wh(raw)
                score = (w * h, len(raw))
                if best is None or score > best[0]:
                    best = (score, raw, mime)
            except Exception:
                last_err = "LEONARDO_DOWNLOAD_FAILED"
        if best is not None:
            _score, raw, mime = best
            return "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode()), None
        return None, last_err
    return None, "LEONARDO_RESULT_NOT_FOUND"

def download_page_image(page, context, url):
    if not url:
        return None, "IMAGE_NOT_FOUND: empty source"
    if url.startswith("blob:"):
        try:
            data_url = page.evaluate("""async (source) => {
              const response = await fetch(source);
              if (!response.ok) throw new Error('blob fetch failed');
              const blob = await response.blob();
              return await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(reader.error || new Error('blob read failed'));
                reader.readAsDataURL(blob);
              });
            }""", url)
            if isinstance(data_url, str) and data_url.startswith("data:image"):
                return data_url, None
        except Exception:
            return None, "IMAGE_NOT_FOUND: browser blob download failed"
    return download_result_image(context, url)

def download_chatgpt_image_action(page):
    selectors = (
        'button[aria-label*="Download" i]',
        'button[title*="Download" i]',
        '[data-testid*="download" i]',
        'a[download]',
    )
    for selector in selectors:
        try:
            matches = page.locator(selector)
            count = min(6, matches.count())
            for index in range(count - 1, -1, -1):
                button = matches.nth(index)
                if not button.is_visible():
                    continue
                try:
                    with page.expect_download(timeout=5000) as pending:
                        button.click(timeout=2000)
                    download = pending.value
                    path = download.path()
                    if not path or not os.path.isfile(path):
                        continue
                    with open(path, "rb") as source:
                        raw = source.read()
                    if not image_magic_ok(raw):
                        continue
                    width, height = image_wh(raw)
                    mime = "image/png"
                    if raw[:3] == b"\\xff\\xd8\\xff":
                        mime = "image/jpeg"
                    elif raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
                        mime = "image/webp"
                    return raw, mime, width, height
                except Exception:
                    continue
        except Exception:
            continue
    return None

def run_leonardo(body, ctx=None):
    ctx = ctx or JobRuntimeContext(body)
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
    ident = proxy_identity_error(body, proxy)
    if ident:
        return {"ok": False, "error": ident, "fault": "proxy", "backendMode": "web_account"}
    if not proxy:
        return {"ok": False, "error": proxy_fail_error(body, True), "fault": "proxy", "backendMode": "web_account"}
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
              const n = document.querySelector('[data-testid="image-generation-sidebar-container"] [data-testid="model-selector-trigger"], [data-testid="model-selector-trigger"]') || buttons.find((e) => {
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
        for spec in ('[data-testid="image-generation-sidebar-container"] [data-testid="model-selector-trigger"]', '[data-testid="model-selector-trigger"]', 'button:has-text("Model")', '[aria-label="Model"]', '[aria-label^=Model]', 'button:has-text("Auto")'):
            try:
                loc = page.locator(spec).first
                if loc.count() == 0:
                    continue
                loc.click(timeout=1400, force=True)
                page.wait_for_timeout(700)
                page.evaluate("""() => {
                  const el = document.querySelector('[role=listbox], [role=menu], [data-slot=drawer-content], [data-radix-scroll-area-viewport]');
                  if (el) el.scrollTop = 0;
                }""")
                page.wait_for_timeout(250)
            except Exception:
                continue
            try:
                texts = page.evaluate("""() => [...document.querySelectorAll('[role=menuitem], [role=option], [data-slot=dropdown-menu-item], [data-radix-collection-item], li, button')].map(e => (e.innerText||'').trim()).filter(t => t && t.length >= 4 && t.length < 80)""")
            except Exception:
                texts = []
            if isinstance(texts, list):
                for t in texts:
                    line = [ln.strip() for ln in str(t).split("\\n") if ln.strip()]
                    for label in line:
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
        ready, warm_state = ensure_leonardo_ready(page, lambda: goto_ai_creation(page))
        pst = detect_page_state(page, "leonardo")
        if not ready:
            return fail_job(ctx, "LEONARDO_DOM_CHANGED: page not WARM_IDLE after cleanup", "provider", {"pageState": pst, "runtimeState": warm_state, "backendMode": "web_account"})
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
        model_click = click_leonardo_model(page, picked)
        if not model_click:
            return fail_job(ctx, "LEONARDO_DOM_CHANGED: cannot select exact model " + picked, "provider", {"backendMode": "web_account", "availableModels": available, "modelActual": shown or ""})
        page.wait_for_timeout(700)
        shown2 = selected_model_label(page)
        print("leonardo picked=%s shown=%s click=%s" % (picked, shown2, model_click), flush=True)
        if not pick_model_label([shown2], labels):
            return fail_job(ctx, "LEONARDO_MODEL_MISMATCH: requested %s got %s" % (model, shown2 or "(unreadable)"), "provider", {"backendMode": "web_account", "availableModels": available, "modelActual": shown2 or ""})
        picked = shown2
        if kind == "canary":
            canary_aspect = body.get("aspect") or size_to_aspect(want_size)
            canary_w, canary_h = parse_size_wh(want_size)
            canary_tier, _canary_px = size_tier(canary_w, canary_h, gpt)
            if body.get("tier"):
                canary_tier = str(body.get("tier"))
            size_ok, shown_w, shown_h, size_error = confirm_leonardo_image_size(
                page, want_size, canary_aspect, canary_tier, gpt
            )
            if not size_ok:
                return fail_job(ctx, size_error, "provider", {
                    "pageState": detect_page_state(page, "leonardo"),
                    "backendMode": "web_account",
                    "availableModels": available,
                    "modelActual": picked,
                })
            return {
                "ok": True,
                "url": "",
                "text": "CANARY",
                "pageState": detect_page_state(page, "leonardo"),
                "modelActual": picked,
                "availableModels": available,
                "backendMode": "web_account",
                "selectorPackVersion": pack_version,
                "requestedSize": want_size,
                "actualWidth": shown_w,
                "actualHeight": shown_h,
                "actualAspect": canary_aspect,
            }
        aspect = body.get("aspect") or size_to_aspect(want_size)
        want_w, want_h = parse_size_wh(want_size)
        tier, px = size_tier(want_w, want_h, gpt)
        if body.get("tier"):
            tier = str(body.get("tier"))
        want_min = int(max(want_w, want_h) * 0.72)
        size_ok, shown_w, shown_h, size_error = confirm_leonardo_image_size(page, want_size, aspect, tier, gpt)
        print("leonardo size want=%s aspect=%s tier=%s %dx%d min=%d shown=%dx%d" % (want_size, aspect, tier, want_w, want_h, want_min, shown_w, shown_h), flush=True)
        if not size_ok:
            return fail_job(ctx, size_error, "provider", {"backendMode": "web_account", "availableModels": available, "modelActual": picked})
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
                      const lab = nodes.find((e) => /number of generations/i.test((e.innerText || '').split('\\\\n')[0] || '') && (e.innerText || '').length < 80);
                      const root = lab ? (lab.parentElement || document.body) : document.body;
                      const btn = [...root.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === String(n));
                      if (btn) btn.click();
                    }""",
                    want_n,
                )
            except Exception:
                pass
        requested, ref_hashes, _descs = bind_reference_hashes(ctx, images)
        ref_sizes = set(int(d.get("byte_size") or 0) for d in _descs if d.get("byte_size"))
        if images:
            print("leonardo filling prompt before refs", flush=True)
            leonardo_js_fill(page, prompt)
            up_err = attach_leonardo_refs(page, images)
            if up_err:
                return {"ok": False, "error": up_err + " url=" + (page.url or ""), "fault": "provider", "backendMode": "web_account", "availableModels": available, "modelActual": picked}
            attached = wait_leonardo_refs(page, 10000)
            print("leonardo refs attached count=%s requested=%s hashes=%d" % (attached, requested, len(ref_hashes)), flush=True)
            miss = attachment_incomplete(requested, attached if isinstance(attached, int) else (1 if attached else 0))
            if miss:
                return fail_job(ctx, miss, "provider", {"backendMode": "web_account", "availableModels": available, "modelActual": picked, "attachedReferenceCount": attached, "requestedReferenceCount": requested})
            post_ref_model = click_leonardo_model(page, picked)
            print("leonardo post-ref model target=%s click=%s" % (picked, post_ref_model), flush=True)
            if not post_ref_model:
                return fail_job(ctx, "LEONARDO_DOM_CHANGED: reference changed model and exact restore failed", "provider", {"backendMode": "web_account", "availableModels": available, "modelActual": selected_model_label(page) or ""})
            page.wait_for_timeout(500)
            attached = wait_leonardo_refs(page, 4000)
            miss = attachment_incomplete(requested, attached if isinstance(attached, int) else (1 if attached else 0))
            if miss:
                return fail_job(ctx, miss + " after model restore", "provider", {"backendMode": "web_account", "availableModels": available, "modelActual": picked, "attachedReferenceCount": attached, "requestedReferenceCount": requested})
            filled = leonardo_js_fill(page, prompt)
            print("leonardo fill js", filled, flush=True)
            if not filled:
                return {"ok": False, "error": "LEONARDO_DOM_CHANGED: cannot fill prompt", "fault": "provider", "backendMode": "web_account"}
            size_ok, shown_w, shown_h, size_error = confirm_leonardo_image_size(page, want_size, aspect, tier, gpt)
            if not size_ok:
                return fail_job(ctx, size_error, "provider", {"backendMode": "web_account", "availableModels": available, "modelActual": picked})
            ready_gen = wait_leonardo_generate_ready(page, 20000)
            print("leonardo generate ready", ready_gen, flush=True)
            if not ready_gen:
                return {"ok": False, "error": "LEONARDO_GENERATION_FAILED: generate did not become ready after refs", "fault": "provider", "backendMode": "web_account", "availableModels": available, "modelActual": picked, "pageState": "GENERATION_FAILED"}
        else:
            filled = leonardo_js_fill(page, prompt)
            if not filled:
                filled = fill_composer(page, box, prompt)
            if not filled:
                try:
                    box.fill(prompt, timeout=1000)
                    filled = True
                except Exception:
                    filled = False
            if not filled:
                return {"ok": False, "error": "LEONARDO_DOM_CHANGED: cannot fill prompt", "fault": "provider", "backendMode": "web_account"}
        try:
            page.wait_for_timeout(400)
        except Exception:
            time.sleep(0.4)
        size_ok, shown_w, shown_h, size_error = confirm_leonardo_image_size(page, want_size, aspect, tier, gpt)
        if not size_ok:
            return fail_job(ctx, size_error, "provider", {"backendMode": "web_account", "availableModels": available, "modelActual": picked})
        if not wait_leonardo_generate_ready(page, 20000):
            return fail_job(ctx, "LEONARDO_GENERATION_FAILED: generate did not become ready", "provider", {"backendMode": "web_account", "availableModels": available, "modelActual": picked})
        boundary = create_generation_boundary(page, ctx, "leonardo", prompt)
        baseline = boundary.get("baseline_asset_urls") or snapshot_image_srcs(page)
        captures = []
        captures_by_url = {}
        captured_srcs = set()
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
                if result_is_reference(raw, ref_hashes):
                    return
                w, h = image_wh(raw)
                captures_by_url[url] = (len(raw), w, h, url, raw, ct.split(";")[0])
            except Exception:
                pass
        try:
            page.on("response", on_resp)
        except Exception:
            pass
        print("leonardo clicking generate", flush=True)
        if not set_submission_state(ctx, "SUBMITTING"):
            ctx.submission_state = "INPUT_READY"
            ctx.retry_safety = "SAFE"
            return fail_job(ctx, "WORKER_TIMEOUT: submission checkpoint unavailable", "worker", {"backendMode": "web_account", "availableModels": available, "modelActual": picked})
        gen_clicked = leonardo_js_generate(page)
        if not gen_clicked:
            try:
                page.get_by_role("button", name=re.compile(r"^Generate\b", re.I)).last.click(timeout=1800, force=True)
                gen_clicked = True
            except Exception:
                pass
        if gen_clicked:
            set_submission_state(ctx, "SUBMITTED")
        else:
            ctx.submission_state = "INPUT_READY"
            ctx.retry_safety = "SAFE"
            return fail_job(ctx, "LEONARDO_DOM_CHANGED: visible Generate button disappeared before click", "provider", {"backendMode": "web_account", "availableModels": available, "modelActual": picked})
        page.wait_for_timeout(800)
        pst2 = detect_page_state(page, "leonardo")
        if pst2 in ("LOGIN_REQUIRED", "TOKEN_EXHAUSTED", "QUEUE_FULL", "CHALLENGE"):
            err, fault = page_state_error(pst2, False, "leonardo")
            return {"ok": False, "error": err, "fault": fault, "pageState": pst2, "backendMode": "web_account", "availableModels": available}
        deadline = max(time.time() + 30, t0 + int(body.get("timeoutMs") or 120000) / 1000 - 5)
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
            if any(h in low for h in progress_hint):
                saw_progress = True
            try:
                busy = page.evaluate("""() => {
                  const b = document.querySelector('button[aria-label="Generate"], button[aria-label*="Generate" i]');
                  if (b && (b.disabled || b.getAttribute('aria-disabled') === 'true')) return true;
                  return !!(document.querySelector('[role=progressbar], [data-loading="true"]'));
                }""")
                if busy:
                    saw_progress = True
                    set_submission_state(ctx, "GENERATING")
            except Exception:
                pass
            located_raw = leonardo_result_locator(page, boundary)
            captured_full = set(upgrade_cdn_url(url) for url in captures_by_url.keys())
            for cand in located_raw:
                src = cand.get("src") or ""
                cand["networkCaptured"] = bool(src in captures_by_url or upgrade_cdn_url(src) in captured_full)
            located = pick_accepted_candidates(located_raw, max(1, want_n))
            for cand in located:
                src = cand.get("src") or ""
                if not src or src in baseline:
                    continue
                if src in captured_srcs:
                    continue
                saw_progress = True
                cached = captures_by_url.get(src)
                if cached:
                    _n, w, h, _src, raw, mime = cached
                    if max(w, h) < want_min:
                        full_url, _full_err = download_result_image(context, src)
                        if full_url:
                            try:
                                full_header, full_encoded = full_url.split(",", 1)
                                full_raw = base64.b64decode(full_encoded)
                                full_mime = full_header[5:].split(";")[0] if full_header.startswith("data:") else mime
                                full_w, full_h = image_wh(full_raw)
                                if full_w * full_h > w * h:
                                    raw, mime, w, h = full_raw, full_mime, full_w, full_h
                            except Exception:
                                pass
                else:
                    data_url, _derr = download_result_image(context, src)
                    if not data_url:
                        continue
                    try:
                        header, encoded = data_url.split(",", 1)
                        raw = base64.b64decode(encoded)
                        mime = header[5:].split(";")[0] if header.startswith("data:") else "image/jpeg"
                    except Exception:
                        continue
                    w, h = image_wh(raw)
                if result_is_reference(raw, ref_hashes):
                    continue
                if sha256_hex(raw) in set(ctx.historical_hashes or []):
                    continue
                captures.append((len(raw), w, h, src, raw, mime, cand.get("confidence") or ""))
                captured_srcs.add(src)
                set_submission_state(ctx, "RESULT_DETECTED")
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
        if best and max(best[0][1], best[0][2]) < want_min:
            got = "%dx%d" % (best[0][1], best[0][2])
            return fail_job(ctx, "LEONARDO_RESULT_SIZE_MISMATCH: want %s got %s" % (want_size, got), "provider", {"pageState": "GENERATION_FAILED", "backendMode": "web_account", "availableModels": available, "modelActual": picked})
        if not best:
            set_submission_state(ctx, "RESULT_UNCERTAIN")
            return fail_job(ctx, "RESULT_UNCERTAIN: LEONARDO_RESULT_NOT_FOUND", "provider", {"pageState": "GENERATION_FAILED", "backendMode": "web_account", "availableModels": available, "modelActual": picked})
        for row in best:
            if result_is_reference(row[4], ref_hashes):
                return fail_job(ctx, "RESULT_IS_REFERENCE_IMAGE", "provider", {"pageState": "GENERATION_FAILED", "backendMode": "web_account", "availableModels": available, "modelActual": picked})
            if sha256_hex(row[4]) in set(ctx.historical_hashes or []):
                return fail_job(ctx, "IMAGE_NOT_FOUND: historical asset returned", "provider", {"pageState": "GENERATION_FAILED", "backendMode": "web_account", "availableModels": available, "modelActual": picked})
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
        refs_left = 0 if cleanup_leonardo(page) else count_leonardo_refs(page)
        set_submission_state(ctx, "RESULT_VALIDATED")
        return {
            "ok": True,
            "url": data_urls[0],
            "urls": data_urls,
            "resultConfidences": [row[6] for row in best],
            "width": best[0][1],
            "height": best[0][2],
            "modelActual": picked or model,
            "backendMode": "web_account",
            "latencyMs": int((time.time() - t0) * 1000),
            "pageState": "WARM_IDLE" if refs_left == 0 else "DIRTY",
            "runtimeState": "WARM_IDLE" if refs_left == 0 else "DIRTY",
            "referenceCount": refs_left,
            "warmStats": dict(WARM_STATS),
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
            remember_page(ctx_key, page)
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
        if DRAINING and ACTIVE <= 0 and DISPATCHED <= 0:
            break
        try:
            jobs = snapshot_active_jobs()
            req = urllib.request.Request(
                gw + "/api/worker/next",
                headers={
                    "Authorization": "Bearer " + token,
                    "X-Worker-Name": WORKER_NAME,
                    "X-Worker-Capacity": str(CAPACITY),
                    "X-Worker-Active": str(max(ACTIVE, DISPATCHED)),
                    "X-Worker-Beat-Only": "1",
                    "X-Job-Id": jobs[0][0] if jobs else "",
                    "X-Account-Id": jobs[0][1] if jobs else "",
                    "X-Active-Jobs": json.dumps([{"jobId": jid, "accountId": aid} for jid, aid in jobs]),
                    "X-Worker-Drain": "1" if DRAINING else "0",
                    "X-Worker-Shards": str(SHARD_COUNT),
                    "X-Worker-Shard-Queues": ",".join(str(n) for n in shard_queue_depths()),
                    "X-Worker-Browsers": str(shard_browser_count() or ACTIVE),
                    "X-Worker-Contexts": str(shard_context_count()),
                },
            )
            urllib.request.urlopen(req, timeout=8).read()
        except Exception:
            pass
        time.sleep(4)

def poll_gateway():
    global DISPATCHED
    import urllib.request
    gw = (os.environ.get("RELAY_GATEWAY") or "").rstrip("/")
    token = os.environ.get("RELAY_TOKEN") or ""
    if not gw:
        print("未设置网关地址，只提供本机 /chat")
        return
    print("拉取网关任务", gw, flush=True)
    fail = 0
    while True:
        if DRAINING:
            with DISPATCH_LOCK:
                busy = DISPATCHED
            if busy <= 0 and ACTIVE <= 0:
                print("drain complete", flush=True)
                break
            time.sleep(0.4)
            continue
        try:
            req = urllib.request.Request(
                gw + "/api/worker/next",
                headers={
                    "Authorization": "Bearer " + token,
                    "X-Worker-Name": WORKER_NAME,
                    "X-Worker-Capacity": str(CAPACITY),
                    "X-Worker-Active": str(max(ACTIVE, DISPATCHED)),
                    "X-Worker-Browsers": str(shard_browser_count() or ACTIVE),
                    "X-Worker-Shards": str(SHARD_COUNT),
                    "X-Worker-Shard-Queues": ",".join(str(n) for n in shard_queue_depths()),
                    "X-Worker-Contexts": str(shard_context_count()),
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
                "proxyId": job.get("proxyId") or (data.get("proxy") or {}).get("id"),
                "timeoutMs": job.get("timeoutMs") or 90000,
                "model": job.get("model"),
                "sessionVersion": data.get("sessionVersion") or 0,
                "selectors": data.get("selectors") or job.get("selectors"),
                "selectorPackVersion": data.get("selectorPackVersion") or job.get("selectorPackVersion"),
                "turns": data.get("turns") or job.get("turns") or [],
                "kind": data.get("kind") or job.get("kind"),
                "inspectionId": job.get("inspectionId") or data.get("inspectionId"),
                "leaseId": (data.get("lease") or {}).get("leaseId") or job.get("leaseId"),
                "fencingToken": (data.get("lease") or {}).get("fencingToken") or job.get("fencingToken"),
                "attemptId": (data.get("lease") or {}).get("attemptId") or job.get("attemptId"),
                "requestId": job.get("requestId") or data.get("requestId") or job.get("id"),
                "traceId": job.get("traceId") or data.get("traceId") or job.get("id"),
                "historicalHashes": job.get("historicalHashes") or [],
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
                payload["platform"] = "chatgpt"
                payload["model"] = job.get("model") or "chatgpt-web-auto"
            def _run(payload=payload):
                global DISPATCHED
                try:
                    result = exec_job(payload)
                except Exception as e:
                    result = {"ok": False, "error": "WORKER_CRASH: %s" % str(e)[:240], "fault": "worker"}
                try:
                    post_result(JobRuntimeContext(payload), result)
                finally:
                    with DISPATCH_LOCK:
                        DISPATCHED -= 1
            with DISPATCH_LOCK:
                DISPATCHED += 1
            threading.Thread(target=_run, daemon=True, name="job-%s" % str(payload.get("id") or "")[:8]).start()
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
    start_shards()
    threading.Thread(target=beat_loop, daemon=True).start()
    threading.Thread(target=poll_gateway, daemon=True).start()
    Server(("127.0.0.1", PORT), H).serve_forever()
`;
}
