import { describe, expect, it, vi } from "vitest";
import { findEntries, searchTsQuery } from "./search";

describe("searchTsQuery", () => {
  it("requires every word and lets the last one be the start of a word", () => {
    expect(searchTsQuery("laptop budg")).toBe("'laptop' & 'budg':*");
    expect(searchTsQuery("  Entscheidung ")).toBe("'Entscheidung':*");
  });

  it("keeps hosts, email addresses, and numbers whole, as the text index does", () => {
    expect(searchTsQuery("example.org")).toBe("'example.org':*");
    expect(searchTsQuery("foo@example.org 1.600")).toBe("'foo@example.org' & '1.600':*");
    expect(searchTsQuery("LB-12")).toBe("'LB-12':*");
  });

  it("quotes every word, so operators cannot change the query", () => {
    expect(searchTsQuery(`budget' | !(x) <-> "y":* a\\b`)).toBe(`'budget' & '!(x)' & '"y":*' & 'a' & 'b':*`);
  });

  it("drops NUL, which PostgreSQL rejects in text", () => {
    expect(searchTsQuery("check\u0000list")).toBe("'check' & 'list':*");
  });

  it("has no query without letters or digits", () => {
    expect(searchTsQuery("")).toBeUndefined();
    expect(searchTsQuery(" -!& '' ")).toBeUndefined();
  });

  it("uses at most 20 words", () => {
    expect(searchTsQuery(Array.from({ length: 30 }, (_, i) => `w${i}`).join(" "))).toBe(
      `${Array.from({ length: 19 }, (_, i) => `'w${i}'`).join(" & ")} & 'w19':*`,
    );
  });
});

describe("findEntries", () => {
  const signal = new AbortController().signal;
  const answer = (body: unknown, status = 200) => vi.fn(async () => Response.json(body, { status }));

  it("shows the entries of /api/search with their number as the reference", async () => {
    const request = answer({
      results: [{ ref: "LB-12", title: "Laptop budget", kind: "Decision", href: "/e/LB-12" }],
    });
    await expect(findEntries(" laptop ", signal, request)).resolves.toEqual([
      { href: "/e/LB-12", title: "Laptop budget", reference: "LB-12", kind: "Decision" },
    ]);
    expect(request).toHaveBeenCalledWith("/api/search?q=laptop", { signal });
  });

  it("asks the server from two characters on, or for one digit", async () => {
    const request = answer({ results: [] });
    await expect(findEntries("l", signal, request)).resolves.toEqual([]);
    await expect(findEntries(" ", signal, request)).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
    await findEntries("7", signal, request);
    await findEntries("la", signal, request);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails when the search does not answer, so the frame says so", async () => {
    await expect(findEntries("laptop", signal, answer({ error: "unauthorized" }, 401))).rejects.toThrow(
      "401",
    );
  });
});
