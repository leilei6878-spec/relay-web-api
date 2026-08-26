# Leonardo UI Recon

Generated: 2026-08-26T06:59:37.971197+00:00
Session loaded: True

Secrets (cookies, bearer, passwords) were not recorded.

## Page 1

- requested: `https://app.leonardo.ai/`
- final: `https://app.leonardo.ai/`
- title: Leonardo.Ai App - Generate AI Images, Videos & Designs
- state: **LOGIN_REQUIRED**
- error: none

### Signals

```json
{
  "login": true,
  "challenge": false,
  "generate": true,
  "prompt": true
}
```

### Visible model labels

FLUX, Nano Banana

### Token / plan hints

- Plans

### Selector candidates

```json
{
  "prompt": [
    "[data-testid=\"home-prompt-enhance-button\"]",
    "[aria-label=\"FLUX 3 Video\"]",
    "[aria-label=\"Nano Banana Prompt Guide\"]"
  ],
  "generate": [
    "[aria-label=\"Generate\"]",
    "[aria-label=\"Generate\"]"
  ],
  "model": [],
  "upload": [
    "input[type=file]"
  ],
  "quantity": []
}
```

### Controls (non-secret)

| text | aria | testid | type |
|---|---|---|---|
|  | Leonardo.Ai Home |  | A |
| Home |  |  | A |
| Library |  |  | A |
| Image |  |  | A |
| Video |  |  | A |
| Audio |  |  | A |
| 3D |  |  | A |
| Blueprints |  |  | A |
| Upscaler |  |  | A |
| Flow State |  |  | A |
| Plans |  |  | A |
| More |  |  | button |
| Sign Up |  |  | A |
| Sign In |  |  | A |
|  | Add image reference |  | button |
| Type a prompt... |  |  | TEXTAREA |
|  | Menu | home-prompt-enhance-button | button |
| Generate | Generate |  | button |
| Image | Image generation |  | button |
| Video | Video generation |  | button |
| 1:1 | Aspect ratio: 1:1 |  | button |
| Dynamic | Style: Dynamic |  | button |
| Auto | Model: Auto |  | button |
| Generate | Generate |  | button |
|  | Scroll left |  | button |
| Image |  |  | A |
| Video |  |  | A |
| Audio |  |  | A |
| 3D |  |  | A |
| Blueprints |  |  | A |
| Upscaler |  |  | A |
|  | Scroll right |  | button |
| Seedance 2.5 Precise camera control, con | Seedance 2.5 |  | A |
| FLUX 3 Video High-quality video with syn | FLUX 3 Video |  | A |
| MiniMax H3 MiniMax's flagship 2K video m | MiniMax H3 |  | A |
| Seedream 5.0 Pro High-fidelity text-to-i | Seedream 5.0 Pro |  | A |
| Old Photo Restoration Restore and enhanc | Old Photo Restoration |  | A |
| Consistent Character Generate images of  | Consistent Character |  | A |
| Logo Creator Generate a logo for your br | Logo Creator |  | A |
| Background Change Intelligently change t | Background Change |  | A |

## Page 2

- requested: `https://app.leonardo.ai/generate`
- final: `https://app.leonardo.ai/auth/login?callbackUrl=https%3A%2F%2Fapp.leonardo.ai%2Fgenerate`
- title: Login or Create an Account | Leonardo.Ai
- state: **CHALLENGE**
- error: none

### Signals

```json
{
  "login": true,
  "challenge": true,
  "generate": true,
  "prompt": true
}
```

### Visible model labels

(none)

### Token / plan hints

- (none)

### Selector candidates

```json
{
  "prompt": [],
  "generate": [],
  "model": [],
  "upload": [
    "input[type=file]"
  ],
  "quantity": []
}
```

### Controls (non-secret)

| text | aria | testid | type |
|---|---|---|---|
| Canva |  |  | button |
| Apple |  |  | button |
| Google |  |  | button |
| Microsoft |  |  | button |
| Continue with Email |  |  | button |
| Need help? |  |  | A |
| Privacy Policy |  |  | A |
| Terms of Service |  |  | A |

## Page 3

- requested: `https://app.leonardo.ai/image-generation`
- final: `https://app.leonardo.ai/auth/login?callbackUrl=https%3A%2F%2Fapp.leonardo.ai%2Fgenerate`
- title: Login or Create an Account | Leonardo.Ai
- state: **CHALLENGE**
- error: none

### Signals

```json
{
  "login": true,
  "challenge": true,
  "generate": true,
  "prompt": true
}
```

### Visible model labels

(none)

### Token / plan hints

- (none)

### Selector candidates

```json
{
  "prompt": [],
  "generate": [],
  "model": [],
  "upload": [
    "input[type=file]"
  ],
  "quantity": []
}
```

### Controls (non-secret)

| text | aria | testid | type |
|---|---|---|---|
| Canva |  |  | button |
| Apple |  |  | button |
| Google |  |  | button |
| Microsoft |  |  | button |
| Continue with Email |  |  | button |
| Need help? |  |  | A |
| Privacy Policy |  |  | A |
| Terms of Service |  |  | A |

## Page 4

- requested: `https://app.leonardo.ai/image-generation/new`
- final: `https://app.leonardo.ai/auth/login?callbackUrl=https%3A%2F%2Fapp.leonardo.ai%2Fimage-generation%2Fnew`
- title: Login or Create an Account | Leonardo.Ai
- state: **CHALLENGE**
- error: none

### Signals

```json
{
  "login": true,
  "challenge": true,
  "generate": true,
  "prompt": true
}
```

### Visible model labels

(none)

### Token / plan hints

- (none)

### Selector candidates

```json
{
  "prompt": [],
  "generate": [],
  "model": [],
  "upload": [
    "input[type=file]"
  ],
  "quantity": []
}
```

### Controls (non-secret)

| text | aria | testid | type |
|---|---|---|---|
| Canva |  |  | button |
| Apple |  |  | button |
| Google |  |  | button |
| Microsoft |  |  | button |
| Continue with Email |  |  | button |
| Need help? |  |  | A |
| Privacy Policy |  |  | A |
| Terms of Service |  |  | A |



---

## Logged-in recon (2026-08-26, account in pool)

Session file was present (`AssanteFerraiolo98@hotmail.com`, 4 cookies: `anonymous-id`, `_landing_host`, `_landing_time`, `__cf_bm` on paddle).

**Verdict: not logged in.** `/generate` redirected to `/auth/login?callbackUrl=.../generate`. Home still shows Sign In / Sign Up.

API `POST /v1/images/generations` `model=leonardo-gemini` returned **LEONARDO_LOGIN_REQUIRED**. No image URL, no SVG placeholder.

GPT Image 2 / Gemini family labels on `/generate` remain **UNVERIFIED** until a real Cognito/session Cookie is captured.

