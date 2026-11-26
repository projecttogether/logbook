import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/db/client";
import type { OutageWatch } from "@/lib/db/outage";
import { logger } from "@/lib/logger";
import { startHeartbeat } from "./heartbeat";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "logbook-heartbeat-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** A database whose heartbeat upsert ends as `write` says. */
const database = (write: () => Promise<void>) =>
  ({ insert: () => ({ values: () => ({ onConflictDoUpdate: write }) }) }) as unknown as Database;

function beatOnce(write: () => Promise<void>, failed: OutageWatch["failed"]) {
  const outage = { failed: vi.fn(failed), answered: vi.fn() };
  const stop = startHeartbeat({
    db: database(write),
    workerId: "w1",
    file: path.join(dir, "beat"),
    channels: () => ({}) as never,
    outage,
  });
  return { outage, stop };
}

describe("startHeartbeat", () => {
  it("tells the outage watch that the database answered", async () => {
    const { outage, stop } = beatOnce(
      async () => {},
      () => false,
    );
    await vi.waitFor(() => expect(outage.answered).toHaveBeenCalledTimes(1));
    stop();
  });

  it("leaves a connection error to the outage watch", async () => {
    const warn = vi.spyOn(logger, "warn");
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const { outage, stop } = beatOnce(
      () => Promise.reject(refused),
      () => true,
    );
    await vi.waitFor(() => expect(outage.failed).toHaveBeenCalledWith(refused, "heartbeat"));
    stop();
    expect(warn).not.toHaveBeenCalled();
  });

  it("still warns about any other error", async () => {
    const warn = vi.spyOn(logger, "warn");
    const { outage, stop } = beatOnce(
      () => Promise.reject(new Error("permission denied")),
      () => false,
    );
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        { error: "permission denied" },
        "could not write the heartbeat to the database",
      ),
    );
    stop();
    expect(outage.answered).not.toHaveBeenCalled();
  });
});
