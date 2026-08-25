import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { audit } from "./audit";
import { uid } from "./utils";

export type KeyScope = "chat" | "image";

export type ApiKeyRecord = {
  id: string;
  name: string;
  key: string;
  enabled: boolean;
  scopes: KeyScope[];
  dailyLimit: number;
  createdAt: string;
};

type Store = { keys: ApiKeyRecord[] };

const FILE = resolve("storage", "api-keys.json");

function mintKey() {
  return `sk-relay-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as Store & { apiKey?: string };
    if (Array.isArray(raw.keys) && raw.keys.length) return { keys: raw.keys };
    if (raw.apiKey) {
      return {
        keys: [
          {
            id: "default",
            name: "默认",
            key: raw.apiKey,
            enabled: true,
            scopes: ["chat", "image"],
            dailyLimit: 0,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    }
  } catch {
    /* create */
  }
  return { keys: [] };
}

async function save(store: Store) {
  await mkdir(resolve("storage"), { recursive: true });
  await writeFile(FILE, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
}

export async function listApiKeys() {
  const store = await load();
  if (!store.keys.length) {
    store.keys.push({
      id: uid(),
      name: "默认",
      key: mintKey(),
      enabled: true,
      scopes: ["chat", "image"],
      dailyLimit: 0,
      createdAt: new Date().toISOString(),
    });
    await save(store);
  }
  return store.keys;
}

export async function primaryApiKey() {
  const keys = await listApiKeys();
  return keys.find((k) => k.enabled)?.key || keys[0]?.key || "";
}

export async function createApiKey(input: { name: string; scopes?: KeyScope[]; dailyLimit?: number }) {
  const store = await load();
  if (!store.keys.length) store.keys = await listApiKeys();
  const row: ApiKeyRecord = {
    id: uid(),
    name: input.name.trim() || "未命名",
    key: mintKey(),
    enabled: true,
    scopes: input.scopes?.length ? input.scopes : ["chat", "image"],
    dailyLimit: Math.max(0, Number(input.dailyLimit) || 0),
    createdAt: new Date().toISOString(),
  };
  store.keys.unshift(row);
  await save(store);
  await audit("key.create", row.name);
  return row;
}

export async function patchApiKey(id: string, patch: Partial<Pick<ApiKeyRecord, "name" | "enabled" | "scopes" | "dailyLimit">>) {
  const store = await load();
  const row = store.keys.find((k) => k.id === id);
  if (!row) return { ok: false as const, error: "密钥不存在" };
  Object.assign(row, patch);
  await save(store);
  await audit("key.patch", `${row.name} enabled=${row.enabled}`);
  return { ok: true as const, key: row };
}

export async function findApiKey(token: string) {
  if (!token) return null;
  const keys = await listApiKeys();
  return keys.find((k) => k.key === token) ?? null;
}

export function publicKey(row: ApiKeyRecord) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    scopes: row.scopes,
    dailyLimit: row.dailyLimit,
    createdAt: row.createdAt,
    hint: `${row.key.slice(0, 10)}…${row.key.slice(-4)}`,
  };
}
