import type { SelectorPack } from "./types";

export type ChatgptWebInput = {
  prompt: string;
  timeoutMs: number;
  accountId: string;
  sessionPath: string;
  proxy: {
    type: "http" | "socks5" | "ss";
    host: string;
    port: number;
    username: string;
    password?: string;
    localPort?: number;
  } | null;
  selectors: SelectorPack;
};

export type ProbeProxyInput = {
  type: "http" | "socks5" | "ss";
  host: string;
  port: number;
  username?: string;
  password?: string;
  localPort?: number;
};
