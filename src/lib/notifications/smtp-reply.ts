/**
 * The mail server's own answer to a refused email, for the message of a failed
 * test: one line, without the login, at most 200 characters. Null when the
 * error holds none, or when what answered is no mail server (its text is never
 * quoted).
 */
export function smtpReply(
  error: unknown,
  login: { username: string; password: string | null },
): string | null {
  const { response, command } = (error ?? {}) as { response?: unknown; command?: unknown };
  if (typeof response !== "string" || !/^[45]\d\d(?:[ -]|$)/.test(response)) return null;
  // A server that does not know EHLO is no mail server (FTP greets and refuses alike).
  if (command === "EHLO" || command === "HELO") return null;
  const base64 = (text: string) => Buffer.from(text).toString("base64");
  const parts = [login.username, login.password ?? ""].filter(Boolean);
  const hidden = [
    ...parts,
    ...parts.map(base64),
    base64(`\0${login.username}\0${login.password ?? ""}`),
  ].sort((a, b) => b.length - a.length);
  let reply = response;
  for (const secret of hidden) reply = reply.replaceAll(secret, "***");
  return reply
    .replace(/[\p{C}\s]+/gu, " ")
    .trim()
    .slice(0, 200);
}
