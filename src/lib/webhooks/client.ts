import { createHmac, randomUUID } from "node:crypto";
import type { WebhookPayload } from "./payload";

/*
 * Posts payloads to the webhook URL. Each request is signed with HMAC-SHA256
 * over "<timestamp>.<body>" with the signing secret, so the receiver can check
 * that it comes from Logbook and is recent:
 *
 *   Logbook-Timestamp: <Unix time in seconds>
 *   Logbook-Signature: sha256=<hex digest>
 *   Logbook-Delivery: <random ID of this request>
 *
 * Any 2xx answer counts as delivered.
 */

export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookError";
  }
}

export interface WebhookClient {
  send(payload: WebhookPayload): Promise<void>;
}

/** The signature header value for a body sent at `timestamp` (Unix seconds). */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function createWebhookClient(options: {
  url: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}): WebhookClient {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async send(payload) {
      const body = JSON.stringify(payload);
      const timestamp = Math.floor(now() / 1000);
      const signature = signWebhook(options.secret, timestamp, body);
      const deliveryId = randomUUID();
      let response: Response;
      try {
        response = await fetchImpl(options.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Logbook-Webhook",
            "logbook-timestamp": String(timestamp),
            "logbook-signature": signature,
            "logbook-delivery": deliveryId,
            // Existing receivers may still verify these header names.
            "logbuch-timestamp": String(timestamp),
            "logbuch-signature": signature,
            "logbuch-delivery": deliveryId,
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Only the error's code or name: its message can quote the whole URL, such as one with a user name.
        const { name, cause } = error as Error & { cause?: { code?: string } };
        throw new WebhookError(`Request to ${new URL(options.url).origin} failed: ${cause?.code ?? name}`);
      }
      // The status determines delivery. Discard the body so receiver content
      // is neither buffered in memory nor copied into delivery diagnostics.
      void response.body?.cancel().catch(() => {});
      if (!response.ok) throw new WebhookError(`The webhook answered HTTP ${response.status}`);
    },
  };
}
