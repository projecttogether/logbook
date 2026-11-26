import type { SearchResult as FrameSearchResult } from "@/components/ui/app-frame";

/**
 * The words of a search as a PostgreSQL tsquery: every word must match, and
 * the last one may be the start of a word, so the search finds entries while
 * someone is still typing. Each word is quoted, so PostgreSQL's parser reads
 * it as in the text: example.org, an email address, or 1.600 stays one word.
 * Inside quotes only ' and \ are special, and they never reach the query,
 * nor does NUL, which PostgreSQL rejects in text. Undefined when the search
 * has no words.
 */
export function searchTsQuery(q: string): string | undefined {
  const words = q
    .replace(/['\\\0]/g, " ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, 20);
  if (!words.length) return undefined;
  return words.map((word, index) => `'${word}'${index === words.length - 1 ? ":*" : ""}`).join(" & ");
}

/** One entry the search in the sidebar found (`/api/search`). */
export interface SearchResult {
  ref: string;
  title: string;
  /** The entry's type, or where a proposal stands. */
  kind: string;
  href: string;
}

/**
 * The entries for the frame's search (⌘K): from two characters on, or one
 * digit, so "7" finds LB-7. Shorter queries show only the app's pages.
 */
export async function findEntries(
  query: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<FrameSearchResult[]> {
  const term = query.trim();
  if (term.length < 2 && !/^\d$/.test(term)) return [];
  const response = await request(`/api/search?${new URLSearchParams({ q: term })}`, { signal });
  if (!response.ok) throw new Error(`The search answered ${response.status}.`);
  const { results } = (await response.json()) as { results: SearchResult[] };
  return results.map(({ ref, title, kind, href }) => ({ href, title, reference: ref, kind }));
}
