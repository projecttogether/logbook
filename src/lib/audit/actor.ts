/*
 * Who changes a setting: an admin on a page, or the operator on the command
 * line (`cli`, docs/deployment.md). The operator is an object with a symbol,
 * which no request can carry: Server Actions build their actor from the
 * session, and JSON drops symbols. Audit entries with the actor `environment`
 * come from an earlier version, which copied old variables into the database.
 */

const OPERATOR = Symbol("logbook.operator");

/** Whoever runs an operator command on the server, with an admin's rights. */
export interface Operator {
  readonly [OPERATOR]: true;
  /** The command for the audit log, without values, e.g. "cli settings apply slack". */
  readonly command: string;
}

/** An admin signed in to Logbook. */
export interface AdminActor {
  readonly personId: string;
}

export type SettingsActor = AdminActor | Operator;

/** The operator running `command`. Only the command line (src/cli) creates one. */
export function operator(command: string): Operator {
  return { [OPERATOR]: true, command };
}

export function isOperator(actor: unknown): actor is Operator {
  return typeof actor === "object" && actor !== null && OPERATOR in actor;
}

/** The person to record, if any, and how the audit payload names the actor. */
export function auditActor(actor: SettingsActor): {
  actorId: string | null;
  payload: Record<string, unknown>;
} {
  if (isOperator(actor)) return { actorId: null, payload: { actor: "operator", command: actor.command } };
  return { actorId: actor.personId, payload: {} };
}
