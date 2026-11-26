import { EventEmitter } from "node:events";
import { DatabaseError } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutageWatch } from "@/lib/db/outage";
import { logger } from "@/lib/logger";
import { handleBossErrors } from "./boss-errors";

function setUp() {
  const boss = new EventEmitter();
  const report = vi.fn();
  const outage = createOutageWatch({ report: vi.fn() });
  handleBossErrors(boss as unknown as Parameters<typeof handleBossErrors>[0], outage, report);
  return { boss, report };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleBossErrors", () => {
  it("does not report pg-boss's connections dropped by a restart (LOGBUCH-1, LOGBUCH-2)", () => {
    const { boss, report } = setUp();
    const terminated = Object.assign(
      new DatabaseError("terminating connection due to administrator command", 0, "error"),
      { code: "57P01" },
    );
    boss.emit("error", terminated);
    boss.emit("error", {
      code: "57P03",
      message: "the database system is shutting down (Queue: directory-sync, Worker: w1)",
      queue: "directory-sync",
    });
    expect(report).not.toHaveBeenCalled();
  });

  it("reports any other error with its message and stack only", () => {
    const error = vi.spyOn(logger, "error");
    const { boss, report } = setUp();
    boss.emit("error", {
      code: "42703",
      message: 'column "x" does not exist (Queue: reminders, Worker: w1)',
      stack: 'Error: column "x" does not exist',
      params: ["erika@example.org"],
    });
    expect(report).toHaveBeenCalledTimes(1);
    const reported = report.mock.calls[0]![0] as Error;
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe('column "x" does not exist (Queue: reminders, Worker: w1)');
    expect(reported).not.toHaveProperty("params");
    expect(error).toHaveBeenCalledWith(
      { error: 'column "x" does not exist (Queue: reminders, Worker: w1)' },
      "pg-boss error",
    );
  });
});
