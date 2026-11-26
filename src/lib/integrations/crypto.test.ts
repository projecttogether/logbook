import { describe, expect, it } from "vitest";
import { deriveSealingKey, open, seal, SealedValueError, secretHint } from "./crypto";

const key = deriveSealingKey("x".repeat(32));

describe("sealed secrets", () => {
  it("open with the same key and field, and look different each time", () => {
    const first = seal(key, "slack.botToken", "xoxb-secret-value");
    const second = seal(key, "slack.botToken", "xoxb-secret-value");
    expect(first).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(first).not.toContain("xoxb");
    expect(first).not.toBe(second);
    expect(open(key, "slack.botToken", first)).toBe("xoxb-secret-value");
    expect(open(deriveSealingKey("x".repeat(32)), "slack.botToken", second)).toBe("xoxb-secret-value");
  });

  it("do not open with another BETTER_AUTH_SECRET, in another field, or changed", () => {
    const sealed = seal(key, "webhook.secret", "a-signing-secret-value");
    expect(() => open(deriveSealingKey("y".repeat(32)), "webhook.secret", sealed)).toThrow(SealedValueError);
    expect(() => open(key, "slack.botToken", sealed)).toThrow(SealedValueError);
    const [version, iv, body] = sealed.split(".");
    const flipped = `${body!.slice(0, -2)}${body!.endsWith("A") ? "B" : "A"}${body!.slice(-1)}`;
    expect(() => open(key, "webhook.secret", `${version}.${iv}.${flipped}`)).toThrow(SealedValueError);
    expect(() => open(key, "webhook.secret", "v2.x.y")).toThrow(SealedValueError);
    expect(() => open(key, "webhook.secret", "plain text")).toThrow(SealedValueError);
  });

  it("open what the key of BETTER_AUTH_SECRET sealed before", () => {
    // Pinned: a change to the derivation (salt, info, length) makes every saved secret unreadable.
    expect(
      open(key, "webhook.secret", "v1.BwcHBwcHBwcHBwcH.CTDQPO_Gl5EbFHz8jG5SCvzviEvufCDqfFPA4zcUvK74LCRnK9M"),
    ).toBe("a-signing-secret-value");
  });

  it("keep the key out of JSON and logs", () => {
    expect(JSON.stringify({ key })).toBe('{"key":"[sealing key]"}');
  });
});

describe("secretHint", () => {
  it("shows the last four characters of a long secret, nothing of a short one", () => {
    expect(secretHint("xoxb-1234-abcd")).toBe("…abcd");
    expect(secretHint("short-pass1")).toBeNull();
  });
});
