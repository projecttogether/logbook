import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { createDb, type Database } from "@/lib/db/client";

export interface TestDatabase {
  pool: Pool;
  db: Database;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Connects to the test database prepared by global-setup.ts. */
export function connectTestDatabase(): TestDatabase {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is not set");
  const pool = new Pool({ connectionString, max: 5 });
  const db = createDb(pool);
  return {
    pool,
    db,
    async reset() {
      await db.execute(sql`
        truncate table auth_session, auth_account, auth_verification, auth_user,
          notification_delivery, person_active_month, webhook_state, entry_import, response, proposal_version, entry_affected_team, decision, proposal, app_setting,
          entry_tag, entry_relation, participant, outcome, entry_revision, addendum,
          audit_event, rate_limit, entry, tag,
          person, team, directory_sync_run, worker_heartbeat
        restart identity cascade
      `);
    },
    close: () => pool.end(),
  };
}

/**
 * Its own connections to the test database, which show each statement's SQL
 * to `intercept` before running it (statements outside transactions).
 * Throwing fails the statement, as an unavailable database would; awaiting a
 * change on another connection plays a concurrent write.
 */
export function connectInterceptedDatabase(
  intercept: (sql: string) => void | Promise<void>,
): Pick<TestDatabase, "db" | "close"> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error("TEST_DATABASE_URL is not set");
  const pool = new Pool({ connectionString, max: 2 });
  const query = pool.query.bind(pool) as (
    config: string | { text: string },
    ...rest: unknown[]
  ) => Promise<unknown>;
  pool.query = (async (config: string | { text: string }, ...rest: unknown[]) => {
    await intercept(typeof config === "string" ? config : config.text);
    return query(config, ...rest);
  }) as unknown as typeof pool.query;
  return { db: createDb(pool), close: () => pool.end() };
}
