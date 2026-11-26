import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/*
 * Seals the secrets of the integrations (Slack's bot token, the SMTP
 * password, MailerSend's API token, the webhook's URL and signing secret) for
 * the database, with AES-256-GCM. The key is derived from BETTER_AUTH_SECRET with
 * HKDF, so Logbook needs no new variable: the backups already name
 * BETTER_AUTH_SECRET as the setting a restore needs, and without it the
 * secrets must be entered again. Each sealed value names its field as
 * associated data, so a value cannot be moved to another field.
 *
 *   v1.<IV, base64url>.<ciphertext and tag, base64url>
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BRAND = Symbol("logbook.sealing-key");

/** The derived key. Opaque, so it is not printed or logged by accident. */
export interface SealingKey {
  readonly [BRAND]: Buffer;
}

/** A sealed value that cannot be opened: another key, or changed in the database. */
export class SealedValueError extends Error {
  constructor() {
    super("A stored secret cannot be read with the current BETTER_AUTH_SECRET.");
    this.name = "SealedValueError";
  }
}

/** The sealing key derived from BETTER_AUTH_SECRET. */
export function deriveSealingKey(secret: string): SealingKey {
  const key = Buffer.from(hkdfSync("sha256", secret, "logbook", "logbook integration secrets v1", 32));
  return Object.freeze({ [BRAND]: key, toJSON: () => "[sealing key]" }) as SealingKey;
}

/** Seals `plaintext` for the field `field`, e.g. "slack.botToken". */
export function seal(key: SealingKey, field: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key[BRAND], iv);
  cipher.setAAD(Buffer.from(field, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/** Opens a value sealed for `field`. Throws SealedValueError when it cannot. */
export function open(key: SealingKey, field: string, sealed: string): string {
  const [version, iv, body] = sealed.split(".");
  if (version !== VERSION || !iv || !body) throw new SealedValueError();
  try {
    const bytes = Buffer.from(body, "base64url");
    if (bytes.length < TAG_BYTES) throw new SealedValueError();
    const decipher = createDecipheriv("aes-256-gcm", key[BRAND], Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(field, "utf8"));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SealedValueError();
  }
}

/**
 * What the page and the command show of a stored secret: its last four
 * characters, e.g. "…a1b2". Short secrets get no hint, so it gives away
 * little of them.
 */
export function secretHint(value: string): string | null {
  return value.length >= 12 ? `…${value.slice(-4)}` : null;
}

/** What they show of a URL, which can carry a token: its server, e.g. "https://hooks.example.org". */
export function urlHint(value: string): string | null {
  return URL.parse(value)?.origin ?? null;
}
