import { resolve } from "node:path";

process.env.RELAY_SKIP_DB = "1";
process.env.RELAY_TEST = "1";
if (!process.env.RELAY_STORAGE_DIR) {
  process.env.RELAY_STORAGE_DIR =
    process.platform === "win32"
      ? resolve("storage", "relay-qa-storage")
      : "/tmp/relay-qa-storage";
}

