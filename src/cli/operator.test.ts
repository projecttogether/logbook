import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditActor, isOperator, operator } from "@/lib/audit/actor";

const SRC = path.resolve(import.meta.dirname, "..");

/** Source files (no tests) that call `name(` or import it from the actor module, also under another name. */
function callers(name: string): string[] {
  const pattern = new RegExp(
    `\\b${name}\\(|import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"[^"]*audit/actor"`,
  );
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => file !== path.join("lib", "audit", "actor.ts"))
    .filter((file) => pattern.test(readFileSync(path.join(SRC, file), "utf8")));
}

describe("the operator", () => {
  it("is created only by the command line, never by a page or route", () => {
    const files = callers("operator");
    expect(files.length).toBeGreaterThan(0);
    expect(
      files.every((file) => file.startsWith(`cli${path.sep}`)),
      files.join(),
    ).toBe(true);
  });

  it("does not survive JSON, so no request can stand for it", () => {
    expect(isOperator(operator("cli settings apply slack"))).toBe(true);
    expect(isOperator(JSON.parse(JSON.stringify(operator("cli settings apply slack"))))).toBe(false);
    expect(isOperator({ command: "cli settings apply slack" })).toBe(false);
  });

  it("is named in the audit log with the command, without a person", () => {
    expect(auditActor(operator("cli settings apply slack"))).toEqual({
      actorId: null,
      payload: { actor: "operator", command: "cli settings apply slack" },
    });
    expect(auditActor({ personId: "p1" })).toEqual({ actorId: "p1", payload: {} });
  });
});
