/** Browser pool is NOT being refactored this round. Collect baseline only. */

export type BrowserSample = {
  at: number;
  startLatencyMs?: number;
  crash?: boolean;
  ramMb?: number;
  cpu?: number;
};

const samples: BrowserSample[] = [];
const MAX = 2000;

export function observeBrowser(row: Omit<BrowserSample, "at">) {
  samples.push({ at: Date.now(), ...row });
  if (samples.length > MAX) samples.splice(0, samples.length - MAX);
}

export function browserBaseline() {
  const start = samples.map((s) => s.startLatencyMs).filter((n): n is number => typeof n === "number");
  const crashes = samples.filter((s) => s.crash).length;
  const ram = samples.map((s) => s.ramMb).filter((n): n is number => typeof n === "number");
  const cpu = samples.map((s) => s.cpu).filter((n): n is number => typeof n === "number");
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    samples: samples.length,
    browser_start_latency_avg: avg(start),
    browser_crash_rate: samples.length ? crashes / samples.length : 0,
    RAM_per_request_avg: avg(ram),
    CPU_per_request_avg: avg(cpu),
    note: "Baseline only. Complex resident browser pool is deferred until startup latency is the bottleneck.",
  };
}

export function resetBrowserBaselineForTests() {
  samples.length = 0;
}
