import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestSession } from "./auth";
import { requireAdmin, requireUser, sessionStatus } from "./session";

const mocks = vi.hoisted(() => ({
  session: vi.fn<() => Promise<RequestSession>>(),
  recordActivity: vi.fn(),
  redirect: vi.fn((url: string): never => {
    throw new Error(`redirect ${url}`);
  }),
  notFound: vi.fn((): never => {
    throw new Error("not found");
  }),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("./auth", () => ({ getLogbookAuth: () => ({ requestSession: mocks.session }) }));
vi.mock("@/lib/measures/activity", () => ({ recordActivity: mocks.recordActivity }));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));

const person = { id: "person-1", hasAccess: true, isAdmin: false } as Extract<
  RequestSession,
  { status: "active" }
>["person"];

beforeEach(() => vi.clearAllMocks());

describe("requireUser", () => {
  it("sends a request without a session to the login page", async () => {
    mocks.session.mockResolvedValue({ status: "none" });
    await expect(requireUser()).rejects.toThrow("redirect /login");
    expect(mocks.recordActivity).not.toHaveBeenCalled();
  });

  it("shows the no-access page when reading the session ended it", async () => {
    mocks.session.mockResolvedValue({ status: "ended" });
    await expect(requireUser()).rejects.toThrow("redirect /no-access");
    expect(mocks.recordActivity).not.toHaveBeenCalled();
  });

  it("returns the person of an active session and notes the month as active", async () => {
    mocks.session.mockResolvedValue({ status: "active", userId: "user-1", person });
    await expect(requireUser()).resolves.toEqual({ userId: "user-1", person });
    expect(mocks.recordActivity).toHaveBeenCalledWith(expect.anything(), person.id);
  });

  it("answers 404 to people who are not admins on admin pages", async () => {
    mocks.session.mockResolvedValue({ status: "active", userId: "user-1", person });
    await expect(requireAdmin()).rejects.toThrow("not found");
  });
});

describe("sessionStatus", () => {
  it("tells the login page whether the session is active, ended, or missing", async () => {
    for (const status of ["none", "ended"] as const) {
      mocks.session.mockResolvedValue({ status });
      expect(await sessionStatus()).toBe(status);
    }
    mocks.session.mockResolvedValue({ status: "active", userId: "user-1", person });
    expect(await sessionStatus()).toBe("active");
  });
});
