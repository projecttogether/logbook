import { describe, expect, it } from "vitest";
import { smtpReply } from "./smtp-reply";

const login = { username: "logbook@example.org", password: "pass word+1" };
const base64 = (text: string) => Buffer.from(text).toString("base64");
const failure = (response: unknown) => Object.assign(new Error("Message failed"), { response });

describe("smtpReply", () => {
  it("is the server's answer on one line", () => {
    expect(
      smtpReply(failure("550-5.7.1 Sender address rejected\r\n550 5.7.1\tsee the docs\u0007"), login),
    ).toBe("550-5.7.1 Sender address rejected 550 5.7.1 see the docs");
  });

  it("holds no login, also encoded", () => {
    const reply = smtpReply(
      failure(
        `535 5.7.8 ${login.username} ${login.password} ${base64(login.username)} ${base64(login.password)} ${base64(`\0${login.username}\0${login.password}`)}`,
      ),
      login,
    );
    expect(reply).toBe("535 5.7.8 *** *** *** *** ***");
  });

  it("hides a login before it cuts the line", () => {
    const reply = smtpReply(failure(`535 ${"x".repeat(190)}${login.password}`), login)!;
    expect(reply).toHaveLength(197);
    expect(reply.endsWith("x***")).toBe(true);
    expect(smtpReply(failure(`535 ${"x".repeat(500)}`), login)).toHaveLength(200);
  });

  it("is the code when the server sends no text", () => {
    expect(smtpReply(failure("550"), login)).toBe("550");
  });

  it("works without a login", () => {
    expect(smtpReply(failure("550 5.1.1 No such user"), { username: "", password: null })).toBe(
      "550 5.1.1 No such user",
    );
  });

  it.each([
    ["no answer", failure(undefined)],
    ["an answer that is no refusal", failure("220 ftp.example.org ready")],
    ["another kind of server", failure("HTTP/1.1 400 Bad Request")],
    ["a longer number", failure("4501")],
    ["a server that does not know EHLO", { ...failure("500 what?"), command: "HELO" }],
    ["no error", null],
  ])("is null for %s", (_, error) => {
    expect(smtpReply(error, login)).toBeNull();
  });
});
