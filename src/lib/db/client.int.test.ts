import { expect, it, vi } from "vitest";
import { connectTestDatabase } from "../../../tests/integration/db";
import { getDatabaseConfig } from "../config";
import { logger } from "../logger";
import { createPool } from "./client";

it("replaces a connection lost while idle without an unhandled pool error", async () => {
  const testDb = connectTestDatabase();
  const pool = createPool(getDatabaseConfig().DATABASE_URL, "logbook-pool-test");
  const warn = vi.spyOn(logger, "warn");
  try {
    const idle = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
    const pid = idle.rows[0]!.pid;
    expect(pool.idleCount).toBe(1);

    const result = await testDb.pool.query<{ terminated: boolean }>(
      "select pg_terminate_backend($1, 5000) as terminated",
      [pid],
    );
    expect(result.rows[0]?.terminated).toBe(true);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: "57P01" }),
        "idle PostgreSQL connection failed",
      );
    });

    const replacement = await pool.query<{ pid: number }>("select pg_backend_pid() as pid");
    expect(replacement.rows[0]?.pid).not.toBe(pid);
  } finally {
    warn.mockRestore();
    await pool.end();
    await testDb.close();
  }
});
