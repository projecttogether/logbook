import { PgBoss, type Job } from "pg-boss";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { connectTestDatabase, type TestDatabase } from "../../tests/integration/db";
import { startTcpProxy, type TcpProxy } from "../../tests/integration/tcp-proxy";
import { createOutageWatch, type OutageWatch } from "@/lib/db/outage";
import { handleBossErrors } from "./boss-errors";

// The worker's pg-boss setup, reaching the test database through a proxy
// that drops every connection and refuses new ones, as PostgreSQL does while
// it restarts. Expiry is checked every second instead of every minute.
const SCHEMA = "pgboss_restart_test";
const QUEUE = "restart-test";
const APPLICATION = "logbook-restart-test";

let testDb: TestDatabase;
let proxy: TcpProxy;
let boss: PgBoss;
let failed: MockInstance<OutageWatch["failed"]>;
const reported = vi.fn<(error: unknown) => void>();
const unreachable = vi.fn();
let processed: string[];
let handler: (job: Job<unknown>) => Promise<void>;

beforeEach(async () => {
  testDb = connectTestDatabase();
  await testDb.pool.query(`drop schema if exists ${SCHEMA} cascade`);
  proxy = await startTcpProxy(process.env.TEST_DATABASE_URL!);
  boss = new PgBoss({
    connectionString: proxy.url,
    application_name: APPLICATION,
    schema: SCHEMA,
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
  });
  const outage = createOutageWatch({ report: unreachable });
  failed = vi.spyOn(outage, "failed");
  handleBossErrors(boss, outage, reported);
  await boss.start();
  await boss.createQueue(QUEUE, { retryLimit: 1, retryDelay: 0, expireInSeconds: 2 });
  processed = [];
  handler = async (job) => void processed.push(job.id);
  await boss.work(QUEUE, { pollingIntervalSeconds: 0.5 }, async ([job]) => handler(job!));
});

afterEach(async () => {
  await boss.stop({ graceful: false, timeout: 1_000 });
  await proxy.close();
  await testDb.pool.query(`drop schema if exists ${SCHEMA} cascade`);
  await testDb.close();
  reported.mockReset();
  unreachable.mockReset();
});

const message = (error: unknown) => String((error as { message?: unknown }).message);

it("carries on when the server terminates pg-boss's connections (LOGBUCH-1)", async () => {
  const first = await boss.send(QUEUE, {});
  await vi.waitFor(() => expect(processed).toContain(first), { timeout: 10_000 });

  const terminated = await testDb.pool.query(
    "select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1",
    [APPLICATION],
  );
  expect(terminated.rowCount).toBeGreaterThan(0);
  await vi.waitFor(() =>
    expect(failed.mock.calls.map(([error]) => message(error))).toContain(
      "terminating connection due to administrator command",
    ),
  );

  // The pool may still hand out another connection PostgreSQL is closing (its
  // error not yet reported), so the send is tried again until it gets a live
  // one; the point is that the worker goes on with the new job.
  const second = await vi.waitFor(() => boss.send(QUEUE, {}), { timeout: 10_000 });
  await vi.waitFor(() => expect(processed).toContain(second), { timeout: 10_000 });
  expect(failed.mock.results.every((result) => result.value === true)).toBe(true);
  expect(reported).not.toHaveBeenCalled();
  expect(unreachable).not.toHaveBeenCalled();
});

it("runs a job again that was claimed when the database went away, and goes on with new jobs (LOGBUCH-2)", async () => {
  const claimedJob = Promise.withResolvers<void>();
  const outageStarted = Promise.withResolvers<void>();
  handler = async (job) => {
    processed.push(job.id);
    if (processed.length === 1) {
      claimedJob.resolve();
      // The handler finishes during the outage, so pg-boss cannot complete the job.
      await outageStarted.promise;
    }
  };
  const claimed = await boss.send(QUEUE, {});
  await claimedJob.promise;
  await proxy.down();
  outageStarted.resolve();

  // pg-boss's polls fail while the database is down.
  await vi.waitFor(
    () =>
      expect(failed.mock.calls.some(([error]) => message(error).includes(`(Queue: ${QUEUE}, Worker: `))).toBe(
        true,
      ),
    {
      timeout: 10_000,
    },
  );
  await proxy.up();

  const next = await boss.send(QUEUE, {});
  await vi.waitFor(
    () => {
      expect(processed.filter((id) => id === claimed)).toHaveLength(2);
      expect(processed).toContain(next);
    },
    { timeout: 20_000 },
  );
  await vi.waitFor(async () => {
    const jobs = await testDb.pool.query<{ state: string }>(
      `select state from ${SCHEMA}.job where id = any($1)`,
      [[claimed, next]],
    );
    expect(jobs.rows.map((row) => row.state)).toEqual(["completed", "completed"]);
  });
  expect(failed.mock.results.every((result) => result.value === true)).toBe(true);
  expect(reported).not.toHaveBeenCalled();
  expect(unreachable).not.toHaveBeenCalled();
});
