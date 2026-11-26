import { DrizzleQueryError } from "drizzle-orm";
import { DatabaseError } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import {
  createOutageWatch,
  DatabaseUnreachableError,
  isConnectionError,
  OUTAGE_REPORT_AFTER_MS,
  waitForDatabase,
} from "./outage";

function databaseError(code: string, message: string): DatabaseError {
  return Object.assign(new DatabaseError(message, message.length, "error"), { code });
}

function systemError(code: string): Error {
  return Object.assign(new Error(`connect ${code} postgres:5432`), { code });
}

/** How pg-boss emits a failed poll: a copy of the error's fields, the queue and worker in the message. */
function bossWorkerError(error: Error): object {
  return {
    ...error,
    message: `${error.message} (Queue: directory-sync, Worker: acb41275-f1af-49d8-b35b-56ddae2f70f4)`,
    stack: error.stack,
    queue: "directory-sync",
    worker: "acb41275-f1af-49d8-b35b-56ddae2f70f4",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isConnectionError", () => {
  it.each([
    [
      "LOGBUCH-1: pg-boss's idle connection on shutdown",
      databaseError("57P01", "terminating connection due to administrator command"),
    ],
    [
      "LOGBUCH-2: a poll while the server shuts down",
      bossWorkerError(databaseError("57P03", "the database system is shutting down")),
    ],
    ["a connection while the server starts", databaseError("57P03", "the database system is starting up")],
    [
      "a crashed server",
      databaseError("57P02", "terminating connection because of crash of another server process"),
    ],
    ["a connection exception", databaseError("08006", "connection failure")],
    ["the server is down", systemError("ECONNREFUSED")],
    ["a dropped socket", systemError("ECONNRESET")],
    ["no container, so no DNS entry", systemError("ENOTFOUND")],
    ["DNS not ready", systemError("EAI_AGAIN")],
    ["a poll on a server that is down", bossWorkerError(systemError("ECONNREFUSED"))],
    ["a connection that ended mid-query", new Error("Connection terminated unexpectedly")],
    ["the same, from a pg-boss poll", bossWorkerError(new Error("Connection terminated unexpectedly"))],
    [
      "a connect that timed out",
      new Error("Connection terminated due to connection timeout", { cause: new Error("timeout expired") }),
    ],
    ["no connection within the pool's timeout", new Error("timeout exceeded when trying to connect")],
    [
      "a client after its connection failed",
      new Error("Client has encountered a connection error and is not queryable"),
    ],
    [
      "a Drizzle query on a dropped connection",
      new DrizzleQueryError(
        "select 1",
        [],
        databaseError("57P01", "terminating connection due to administrator command"),
      ),
    ],
  ])("is true for %s", (_, error) => {
    expect(isConnectionError(error)).toBe(true);
  });

  it.each([
    ["a unique violation", databaseError("23505", "duplicate key value violates unique constraint")],
    ["a missing table", databaseError("42P01", 'relation "entry" does not exist')],
    ["a syntax error", databaseError("42601", 'syntax error at or near "selec"')],
    ["a wrong password", databaseError("28P01", 'password authentication failed for user "logbook"')],
    ["a serialization failure", databaseError("40001", "could not serialize access")],
    ["a protocol violation", databaseError("08P01", "invalid message format")],
    ["a pg-boss poll with bad SQL", bossWorkerError(databaseError("42703", 'column "x" does not exist'))],
    [
      "a Drizzle query with bad data",
      new DrizzleQueryError("insert", [], databaseError("23502", "null value in column")),
    ],
    ["a pool the worker ended itself", new Error("Connection terminated")],
    ["a client the code closed", new Error("Client was closed and is not queryable")],
    ["a bug", new TypeError("Cannot read properties of undefined (reading 'id')")],
    ["a string", "ECONNREFUSED"],
    ["undefined", undefined],
  ])("is false for %s", (_, error) => {
    expect(isConnectionError(error)).toBe(false);
  });
});

describe("createOutageWatch", () => {
  function watch() {
    let now = Date.parse("2026-11-20T14:34:21Z");
    const report = vi.fn<(error: DatabaseUnreachableError) => void>();
    const outage = createOutageWatch({ report, now: () => now });
    return { outage, report, advance: (ms: number) => (now += ms) };
  }
  const dropped = () => databaseError("57P01", "terminating connection due to administrator command");

  it("warns about a restart once and reports nothing", () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    const { outage, report, advance } = watch();

    expect(outage.failed(dropped(), "pg-boss")).toBe(true);
    advance(2_000);
    expect(outage.failed(systemError("ECONNREFUSED"), "pg-boss")).toBe(true);
    advance(OUTAGE_REPORT_AFTER_MS - 3_000);
    expect(outage.failed(systemError("ECONNREFUSED"), "heartbeat")).toBe(true);
    outage.answered();

    expect(report).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.filter(([, message]) => message === "database unreachable, retrying"),
    ).toHaveLength(1);
    expect(info).toHaveBeenCalledWith({ downSeconds: 299 }, "database reachable again");
  });

  it("repeats the warning once a minute, not on every retry", () => {
    const warn = vi.spyOn(logger, "warn");
    const { outage, advance } = watch();
    for (let second = 0; second < 150; second += 2) {
      outage.failed(systemError("ECONNREFUSED"), "pg-boss");
      advance(2_000);
    }
    expect(warn.mock.calls.map(([, message]) => message)).toEqual([
      "database unreachable, retrying",
      "database still unreachable, retrying",
      "database still unreachable, retrying",
    ]);
  });

  it("reports once when the database stays unreachable, and again after the next long outage", () => {
    const { outage, report, advance } = watch();
    outage.failed(dropped(), "pg-boss");
    advance(OUTAGE_REPORT_AFTER_MS);
    outage.failed(systemError("ENOTFOUND"), "heartbeat");
    advance(60_000);
    outage.failed(systemError("ENOTFOUND"), "heartbeat");

    expect(report).toHaveBeenCalledTimes(1);
    const reported = report.mock.calls[0]![0];
    expect(reported).toBeInstanceOf(DatabaseUnreachableError);
    expect(reported.message).toBe("PostgreSQL unreachable for 5 minutes");
    expect((reported.cause as Error).message).toBe("connect ENOTFOUND postgres:5432");

    outage.answered();
    outage.failed(dropped(), "pg-boss");
    advance(OUTAGE_REPORT_AFTER_MS - 1);
    outage.failed(dropped(), "pg-boss");
    expect(report).toHaveBeenCalledTimes(1);
    advance(1);
    outage.failed(dropped(), "pg-boss");
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("logs and reports the connection error, not Drizzle's query", () => {
    const warn = vi.spyOn(logger, "warn");
    const { outage, report, advance } = watch();
    const failedQuery = () =>
      new DrizzleQueryError('insert into "worker_heartbeat"', ["w1"], systemError("ECONNREFUSED"));
    outage.failed(failedQuery(), "heartbeat");
    advance(OUTAGE_REPORT_AFTER_MS);
    outage.failed(failedQuery(), "heartbeat");
    expect(warn).toHaveBeenCalledWith(
      { source: "heartbeat", err: expect.objectContaining({ code: "ECONNREFUSED" }) },
      "database unreachable, retrying",
    );
    expect((report.mock.calls[0]![0].cause as Error).message).toBe("connect ECONNREFUSED postgres:5432");
  });

  it("leaves other errors to the caller", () => {
    const warn = vi.spyOn(logger, "warn");
    const { outage, report, advance } = watch();
    expect(
      outage.failed(databaseError("23505", "duplicate key value violates unique constraint"), "pg-boss"),
    ).toBe(false);
    advance(OUTAGE_REPORT_AFTER_MS);
    expect(outage.failed(new Error("boom"), "pg-boss")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
});

describe("waitForDatabase", () => {
  it("retries connection errors with a growing pause until the database answers", async () => {
    const outage = createOutageWatch({ report: vi.fn() });
    const answered = vi.spyOn(outage, "answered");
    const probe = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(systemError("ECONNREFUSED"))
      .mockRejectedValueOnce(databaseError("57P03", "the database system is starting up"))
      .mockRejectedValueOnce(systemError("ECONNREFUSED"))
      .mockResolvedValueOnce({ rows: [] });
    const pauses: number[] = [];

    await waitForDatabase(probe, outage, async (ms) => void pauses.push(ms));

    expect(probe).toHaveBeenCalledTimes(4);
    expect(pauses).toEqual([1_000, 2_000, 4_000]);
    expect(answered).toHaveBeenCalledTimes(1);
  });

  it("throws any other error at once", async () => {
    const outage = createOutageWatch({ report: vi.fn() });
    const wrongPassword = databaseError("28P01", 'password authentication failed for user "logbook"');
    const sleep = vi.fn(async () => {});

    await expect(waitForDatabase(() => Promise.reject(wrongPassword), outage, sleep)).rejects.toBe(
      wrongPassword,
    );
    expect(sleep).not.toHaveBeenCalled();
  });
});
