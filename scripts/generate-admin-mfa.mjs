import { generateTotpSecret } from "../src/lib/saas-crypto.ts";

const args = new Set(process.argv.slice(2));
if (!args.has("--acknowledge-secret-output")) {
  throw new Error("Refusing to print an MFA secret without --acknowledge-secret-output");
}

const value = (name, fallback) => {
  const prefix = `${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return (match ? match.slice(prefix.length) : fallback).trim();
};

const issuer = value("--issuer", "Relay");
const account = value("--account", "admin");
if (!issuer || issuer.length > 80 || !account || account.length > 160) throw new Error("issuer/account invalid");
const secret = generateTotpSecret();
const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

process.stdout.write([
  "Sensitive one-time output. Add it to an authenticator and the encrypted commercial config; do not save it in Git or CI logs.",
  `SECRET=${secret}`,
  `OTPAUTH_URI=${uri}`,
  "",
].join("\n"));
