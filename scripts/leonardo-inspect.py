#!/usr/bin/env python3
"""Leonardo Image Generator reconnaissance. No secrets in output."""
import json, os, re, time
from datetime import datetime, timezone

OUT = os.environ.get("LEONARDO_RECON_OUT") or "docs/LEONARDO_UI_RECON.md"
STATE = os.environ.get("LEONARDO_STATE") or ""
SOCKS = os.environ.get("LEONARDO_SOCKS") or "socks5://127.0.0.1:18080"
URLS = [
    os.environ.get("LEONARDO_URL") or "https://app.leonardo.ai/",
    "https://app.leonardo.ai/generate",
    "https://app.leonardo.ai/image-generation",
    "https://app.leonardo.ai/image-generation/new",
]
DUMP = os.environ.get("LEONARDO_DUMP") or "/tmp/leonardo-recon"

def redact(s):
    if not s:
        return s
    s = re.sub(r"(authorization|cookie|set-cookie)[:\s]+[^\n]+", r"\1: [redacted]", s, flags=re.I)
    s = re.sub(r"eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}", "[jwt]", s)
    return s

def main():
    from playwright.sync_api import sync_playwright
    os.makedirs(DUMP, exist_ok=True)
    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    state = None
    if STATE and os.path.isfile(STATE):
        with open(STATE, "r", encoding="utf-8") as f:
            state = json.load(f)
        cookies = state.get("cookies") or []
        print("session cookies", len(cookies), "names", sorted({c.get("name") for c in cookies})[:12])
    report = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "session": bool(state),
        "pages": [],
    }
    with sync_playwright() as p:
        kw = {
            "headless": os.environ.get("RELAY_HEADLESS") == "1",
            "args": ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
            "ignore_default_args": ["--enable-automation"],
        }
        browser = p.chromium.launch(**kw)
        ctx_kw = {
            "locale": "en-US",
            "viewport": {"width": 1440, "height": 900},
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "proxy": {"server": SOCKS} if SOCKS else None,
        }
        if state:
            ctx_kw["storage_state"] = state
        ctx = browser.new_context(**{k: v for k, v in ctx_kw.items() if v is not None})
        ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        page = ctx.new_page()
        for url in URLS:
            rec = inspect_page(page, url)
            report["pages"].append(rec)
            if rec.get("state") in ("AUTHENTICATED", "IMAGE_GENERATOR_READY", "MODEL_SELECTOR_READY"):
                break
        browser.close()
    write_md(report)
    with open(os.path.join(DUMP, "recon.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("wrote", OUT)

def inspect_page(page, url):
    rec = {"url_requested": url, "error": None}
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=40000)
        page.wait_for_timeout(4000)
    except Exception as e:
        rec["error"] = str(e)[:200]
        rec["url"] = page.url
        rec["title"] = page.title()
        return rec
    rec["url"] = page.url
    rec["title"] = page.title()
    html = page.content()
    open(os.path.join(DUMP, "page.html"), "w", encoding="utf-8").write(redact(html)[:200000])
    page.screenshot(path=os.path.join(DUMP, "page.png"))
    rec["state"] = classify(page.url, html, rec["title"])
    rec["signals"] = {
        "login": bool(re.search(r"log in|sign in|continue with google|sign up", html, re.I)),
        "challenge": "just a moment" in rec["title"].lower() or "turnstile" in html.lower(),
        "generate": bool(re.search(r"generate|image generation", html, re.I)),
        "prompt": bool(re.search(r"prompt|textarea|contenteditable", html, re.I)),
    }
    rec["controls"] = page.evaluate("""() => {
      const out = [];
      const els = document.querySelectorAll('button, a, [role="button"], [role="combobox"], textarea, input, [contenteditable="true"]');
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const t = (el.innerText || el.getAttribute('placeholder') || '').replace(/\\s+/g,' ').trim().slice(0,80);
        const aria = el.getAttribute('aria-label') || '';
        const testid = el.getAttribute('data-testid') || '';
        const name = el.getAttribute('name') || '';
        const type = el.getAttribute('type') || el.tagName;
        const role = el.getAttribute('role') || '';
        if (!(t || aria || testid)) continue;
        out.push({t, aria, testid, name, type, role, x: Math.round(r.x), y: Math.round(r.y)});
        if (out.length >= 80) break;
      }
      return out;
    }""")
    rec["model_labels"] = page.evaluate("""() => {
      const blob = (document.body && document.body.innerText || '').slice(0, 20000);
      const names = [];
      const re = /GPT Image 2|Nano Banana|Gemini Image|Gemini 2\\.5|Flux|Phoenix|Kino|Lucid|Lightning|SDXL|Image 2/gi;
      let m;
      while ((m = re.exec(blob))) names.push(m[0]);
      return Array.from(new Set(names));
    }""")
    rec["token_hints"] = page.evaluate("""() => {
      const blob = (document.body && document.body.innerText || '').slice(0, 20000);
      const hits = [];
      const re = /token|credits?|fast generations?|queue|unlimited|plan/gi;
      const lines = blob.split('\\n');
      for (const line of lines) {
        if (re.test(line) && line.trim().length < 80) hits.push(line.trim());
        if (hits.length >= 20) break;
      }
      return hits;
    }""")
    rec["file_inputs"] = page.evaluate("""() => Array.from(document.querySelectorAll('input[type=file]')).map(e => ({
      accept: e.getAttribute('accept'),
      multiple: e.multiple,
      name: e.name,
      testid: e.getAttribute('data-testid')
    }))""")
    rec["images"] = page.evaluate("""() => Array.from(document.querySelectorAll('img')).slice(0, 15).map(e => ({
      alt: (e.alt||'').slice(0,40),
      w: e.naturalWidth || e.width,
      h: e.naturalHeight || e.height,
      src_kind: (e.src||'').startsWith('data:') ? 'data' : ((e.src||'').split('/')[2] || '').slice(0,40)
    }))""")
    rec["selector_candidates"] = suggest(rec)
    return rec

def classify(url, html, title):
    low = (html or "").lower()
    t = (title or "").lower()
    if "just a moment" in t or "turnstile" in low:
        return "CHALLENGE"
    if "login" in url.lower() or "sign in" in low or "continue with google" in low:
        return "LOGIN_REQUIRED"
    if "image-generation" in url or "generate" in low:
        return "IMAGE_GENERATOR_READY"
    if "app.leonardo.ai" in url and "login" not in url.lower():
        return "AUTHENTICATED"
    return "DOM_UNKNOWN"

def suggest(rec):
    cands = {"prompt": [], "generate": [], "model": [], "upload": [], "quantity": []}
    for c in rec.get("controls") or []:
        blob = " ".join([c.get("t") or "", c.get("aria") or "", c.get("testid") or ""]).lower()
        if c.get("type") in ("TEXTAREA", "textarea") or "prompt" in blob or c.get("type") == "contenteditable":
            if c.get("testid"):
                cands["prompt"].append('[data-testid="%s"]' % c["testid"])
            elif c.get("aria"):
                cands["prompt"].append('[aria-label="%s"]' % c["aria"])
        if "generate" in blob and c.get("type") in ("BUTTON", "button", "submit"):
            if c.get("testid"):
                cands["generate"].append('[data-testid="%s"]' % c["testid"])
            elif c.get("aria"):
                cands["generate"].append('[aria-label="%s"]' % c["aria"])
            elif c.get("t"):
                cands["generate"].append('button:has-text("%s")' % c["t"][:40])
        if "model" in blob:
            if c.get("testid"):
                cands["model"].append('[data-testid="%s"]' % c["testid"])
        if "upload" in blob or "image" in blob and "add" in blob:
            if c.get("testid"):
                cands["upload"].append('[data-testid="%s"]' % c["testid"])
    cands["upload"] += ["input[type=file]"]
    return {k: v[:4] for k, v in cands.items()}

def write_md(report):
    lines = [
        "# Leonardo UI Recon",
        "",
        "Generated: %s" % report["ts"],
        "Session loaded: %s" % report["session"],
        "",
        "Secrets (cookies, bearer, passwords) were not recorded.",
        "",
    ]
    for i, p in enumerate(report["pages"]):
        lines += [
            "## Page %s" % (i + 1),
            "",
            "- requested: `%s`" % p.get("url_requested"),
            "- final: `%s`" % p.get("url"),
            "- title: %s" % p.get("title"),
            "- state: **%s**" % p.get("state"),
            "- error: %s" % (p.get("error") or "none"),
            "",
            "### Signals",
            "",
            "```json",
            json.dumps(p.get("signals"), indent=2),
            "```",
            "",
            "### Visible model labels",
            "",
            ", ".join(p.get("model_labels") or ["(none)"]) or "(none)",
            "",
            "### Token / plan hints",
            "",
        ]
        for h in p.get("token_hints") or ["(none)"]:
            lines.append("- %s" % h)
        lines += ["", "### Selector candidates", "", "```json", json.dumps(p.get("selector_candidates"), indent=2), "```", ""]
        lines += ["### Controls (non-secret)", "", "| text | aria | testid | type |", "|---|---|---|---|"]
        for c in (p.get("controls") or [])[:40]:
            lines.append("| %s | %s | %s | %s |" % (
                (c.get("t") or "")[:40].replace("|", "/"),
                (c.get("aria") or "")[:40].replace("|", "/"),
                (c.get("testid") or ""),
                c.get("type"),
            ))
        lines.append("")
    open(OUT, "w", encoding="utf-8").write("\n".join(lines) + "\n")

if __name__ == "__main__":
    main()
