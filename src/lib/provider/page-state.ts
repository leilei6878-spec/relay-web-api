import type { PageSignals, PageState, ProviderId } from "./types";

const LOGIN_URL = /\/auth\/login|accounts\.google\.com|signin|\/login/i;
const LOGIN_HTML =
  /sign in to chatgpt|log in|使用 google 账号|sign in with google|create an account|continue with google/i;
const CHALLENGE =
  /captcha|cf-challenge|unusual traffic|verify you are (a )?human|turnstile|recaptcha|checking your browser/i;
const RATE = /too many requests|rate limit|try again later|you.?ve reached|usage limit/i;
const RESTRICTED = /account (has been )?(deactivated|suspended|disabled)|banned|violat(e|ion)|restricted/i;
const PROVIDER_ERR = /something went wrong|internal error|temporarily unavailable/i;

/**
 * Classify a provider page BEFORE treating a missing selector as session death.
 * Selector absence is only SESSION when the page is actually a login wall.
 */
export function detectPageState(signals: PageSignals, _provider?: ProviderId): PageState {
  const url = signals.url || "";
  const html = signals.html || "";
  if (signals.hasCaptcha || CHALLENGE.test(html) || /challenge/i.test(url)) return "CHALLENGE";
  if (signals.hasRestricted || RESTRICTED.test(html)) return "ACCOUNT_RESTRICTED";
  if (signals.hasRateLimit || RATE.test(html)) return "RATE_LIMITED";
  if (signals.hasLoginForm || LOGIN_URL.test(url) || LOGIN_HTML.test(html)) return "LOGIN_REQUIRED";
  if (PROVIDER_ERR.test(html) && !signals.hasComposer) return "PROVIDER_ERROR";
  if (signals.hasStop) return "GENERATING";
  if (signals.hasAssistant && !signals.hasStop) return "RESULT_READY";
  if (signals.hasComposer && signals.hasSend) return "COMPOSER_READY";
  if (signals.hasComposer) return "COMPOSER_READY";
  if (signals.hasAssistant || (signals.cookieNames && signals.cookieNames.length >= 2 && !LOGIN_URL.test(url))) {
    return "AUTHENTICATED";
  }
  if (/chatgpt\.com|gemini\.google/.test(url) && !LOGIN_URL.test(url) && !signals.hasLoginForm) {
    return "AUTHENTICATED";
  }
  if (!signals.hasComposer && (html || url) && !signals.hasLoginForm) return "DOM_UNKNOWN";
  return "DOM_UNKNOWN";
}

export function errorForPageState(state: PageState, selectorFailed?: boolean): {
  code: string;
  message: string;
  polluteAccountPool: boolean;
} {
  switch (state) {
    case "LOGIN_REQUIRED":
      return { code: "LOGIN_REQUIRED", message: "LOGIN_REQUIRED: provider login wall", polluteAccountPool: true };
    case "CHALLENGE":
      return { code: "CHALLENGE", message: "CHALLENGE: captcha or bot wall", polluteAccountPool: false };
    case "RATE_LIMITED":
      return { code: "ACCOUNT_RATE_LIMIT", message: "RATE_LIMITED: provider throttle", polluteAccountPool: true };
    case "ACCOUNT_RESTRICTED":
      return { code: "ACCOUNT_BANNED", message: "ACCOUNT_RESTRICTED: account disabled", polluteAccountPool: true };
    case "PROVIDER_ERROR":
      return { code: "PROVIDER_UNAVAILABLE", message: "PROVIDER_ERROR: provider error page", polluteAccountPool: false };
    case "GENERATING":
      return { code: "GENERATION_TIMEOUT", message: "TIMEOUT: still generating", polluteAccountPool: false };
    case "AUTHENTICATED":
    case "COMPOSER_READY":
    case "RESULT_READY":
    case "DOM_UNKNOWN":
      if (selectorFailed) {
        return {
          code: "PROVIDER_DOM_CHANGED",
          message: `PROVIDER_DOM_CHANGED: selector miss (page_state=${state})`,
          polluteAccountPool: false,
        };
      }
      return { code: "PROVIDER_UNAVAILABLE", message: `PROVIDER_ERROR: page_state=${state}`, polluteAccountPool: false };
    default:
      return { code: "PROVIDER_UNAVAILABLE", message: `PROVIDER_ERROR: page_state=${state}`, polluteAccountPool: false };
  }
}
