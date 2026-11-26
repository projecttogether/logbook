import pino, { type DestinationStream } from "pino";
import { envValue } from "./env";
import { withoutQueryParameters } from "./error-reporting";

// Database errors can include SQL values, causes with row details, and live clients.
function serializeError(error: unknown) {
  const fields =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown; code?: unknown })
      : undefined;
  return {
    type: error instanceof Error ? error.constructor.name : undefined,
    message:
      typeof fields?.message === "string" ? withoutQueryParameters(fields.message) : errorMessage(error),
    code: typeof fields?.code === "string" ? fields.code : undefined,
  };
}

/**
 * JSON logs to stdout, for the container logs. The operator command (`cli`)
 * logs to stderr instead: its stdout carries only its output.
 */
export function createLogger(level: string, destination?: DestinationStream) {
  return pino(
    {
      level,
      base: { service: envValue("LOGBOOK_PROCESS") ?? "web" },
      serializers: {
        err: serializeError,
        // Pino uses the original error message when the call omits a message.
        msg: (message: unknown) => (typeof message === "string" ? withoutQueryParameters(message) : message),
      },
      redact: {
        paths: [
          "*.password",
          "*.secret",
          "*.token",
          "*.accessToken",
          "*.refreshToken",
          "*.idToken",
          "*.authorization",
          // The secrets of an Admin › Integrations body (src/lib/integrations/schemas.ts).
          "*.botToken",
          "*.mailersendToken",
          "*.url",
          "*.*.password",
          "*.*.token",
          "*.*.secret",
          "*.*.botToken",
          "*.*.url",
        ],
        censor: "[redacted]",
      },
    },
    destination,
  );
}

export const logger = createLogger(
  envValue("LOG_LEVEL") ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  envValue("LOGBOOK_PROCESS") === "cli" ? pino.destination({ fd: 2, sync: true }) : undefined,
);

export function errorMessage(error: unknown): string {
  return withoutQueryParameters(error instanceof Error ? error.message : String(error));
}
