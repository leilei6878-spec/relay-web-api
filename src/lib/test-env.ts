process.env.RELAY_SKIP_DB = "1";
process.env.RELAY_TEST = "1";
if (!process.env.RELAY_STORAGE_DIR) {
  process.env.RELAY_STORAGE_DIR = "/tmp/relay-qa-storage";
}

