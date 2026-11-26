/** Shared by the worker and its container health check (kept free of imports). */
export const DEFAULT_HEARTBEAT_FILE = "/tmp/logbook-worker-heartbeat";
export const HEARTBEAT_INTERVAL_MS = 30_000;
