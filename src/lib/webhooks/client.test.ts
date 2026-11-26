import { createHmac } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createWebhookClient, signWebhook, WebhookError } from "./client";
import type { WebhookPayload } from "./payload";

const SECRET = "a-long-shared-secret-for-tests";
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const payload = { event: "entry.changed", entry: { id: "e1", ref: "LB-1" } } as unknown as WebhookPayload;

function receiver(response: Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response instanceof Error) throw response;
    return response;
  });
  return { fetch: fetchImpl as typeof fetch, calls };
}

describe("the webhook client", () => {
  it("posts the payload as JSON with a signature the receiver can check", async () => {
    const fake = receiver(new Response(null, { status: 204 }));
    await createWebhookClient({
      url: "https://hooks.example.org/logbook",
      secret: SECRET,
      fetch: fake.fetch,
      now: () => NOW,
    }).send(payload);

    const { url, init } = fake.calls[0]!;
    expect(url).toBe("https://hooks.example.org/logbook");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    const body = String(init.body);
    expect(JSON.parse(body)).toEqual(payload);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toBe("Logbook-Webhook");
    expect(headers.get("logbook-timestamp")).toBe(String(NOW / 1000));
    expect(headers.get("logbook-delivery")).toMatch(/^[0-9a-f-]{36}$/);
    // What a receiver does: HMAC-SHA256 over "<timestamp>.<raw body>".
    const expected = createHmac("sha256", SECRET)
      .update(`${headers.get("logbook-timestamp")}.${body}`)
      .digest("hex");
    expect(headers.get("logbook-signature")).toBe(`sha256=${expected}`);
    expect(signWebhook(SECRET, NOW / 1000, body)).toBe(`sha256=${expected}`);
    for (const name of ["timestamp", "signature", "delivery"]) {
      expect(headers.get(`logbuch-${name}`)).toBe(headers.get(`logbook-${name}`));
    }
  });

  it("fails on any answer other than 2xx, and on network errors", async () => {
    const rejected = receiver(new Response("unknown signature", { status: 401 }));
    await expect(
      createWebhookClient({ url: "https://hooks.example.org/x", secret: SECRET, fetch: rejected.fetch }).send(
        payload,
      ),
    ).rejects.toThrow(/^The webhook answered HTTP 401$/);
    const down = receiver(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    await expect(
      createWebhookClient({ url: "https://hooks.example.org/x", secret: SECRET, fetch: down.fetch }).send(
        payload,
      ),
    ).rejects.toEqual(new WebhookError("Request to https://hooks.example.org failed: ECONNREFUSED"));
  });

  it("names only the server of a URL in its errors, also of one that fetch refuses and quotes", async () => {
    const client = createWebhookClient({
      url: "https://user:pass-1a2b@hooks.example.org/token-3c4d?key=5e6f",
      secret: SECRET,
    });
    const error = (await client.send(payload).catch((e: unknown) => e)) as Error;
    expect(error).toEqual(new WebhookError("Request to https://hooks.example.org failed: TypeError"));
    expect(error.cause).toBeUndefined();
  });

  it.each([200, 503])("cancels the unused HTTP %i body without waiting for cancellation", async (status) => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("provider response"));
          controller.close();
        },
        cancel,
      }),
      { status },
    );
    const readText = vi.spyOn(response, "text");
    const fake = receiver(response);
    const send = Promise.race([
      createWebhookClient({ url: "https://hooks.example.org/x", secret: SECRET, fetch: fake.fetch }).send(
        payload,
      ),
      setImmediate("cancellation still pending"),
    ]);

    if (response.ok) await expect(send).resolves.toBeUndefined();
    else await expect(send).rejects.toThrow("The webhook answered HTTP 503");
    expect(readText).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
