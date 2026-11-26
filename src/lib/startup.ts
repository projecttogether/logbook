import { validateWebConfig } from "./config";
import { logger } from "./logger";

/**
 * Checks the settings of the web process when it starts
 * (src/instrumentation.ts). Next.js only logs an error of `register()` and
 * then answers every request with it, so an invalid configuration would
 * leave the server running with nothing but 500s. This ends the process
 * instead, as the worker does: Compose shows that `web` exited, and its log
 * names the variable.
 */
export function validateWebConfigOrExit(env: Record<string, string | undefined> = process.env): void {
  try {
    validateWebConfig(env);
  } catch (error) {
    logger.fatal({ err: error }, "web failed to start");
    process.exit(1);
  }
}
