import { locales } from "../../../i18n/routing";

export type PagefindSubResult = {
  title?: string;
  url?: string;
  excerpt?: string;
  plain_excerpt?: string;
};

export type PagefindResultData = {
  url: string;
  excerpt?: string;
  plain_excerpt?: string;
  meta?: {
    title?: string;
    section?: string;
  };
  sub_results?: PagefindSubResult[];
};

export type DocsSearchResult = {
  href: string;
  title: string;
  section?: string;
  excerptHtml: string;
  plainExcerpt: string;
};

export function normalizePagefindUrl(url: string): string {
  let pathname = url;
  let hash = "";

  try {
    const parsed = new URL(url, "https://cmux.com");
    pathname = parsed.pathname;
    hash = parsed.hash;
  } catch {
    const hashIndex = pathname.indexOf("#");
    if (hashIndex >= 0) {
      hash = pathname.slice(hashIndex);
      pathname = pathname.slice(0, hashIndex);
    }
  }

  pathname = pathname.replace(/\/index\.html$/, "");
  if (pathname.length > 1) {
    pathname = pathname.replace(/\/$/, "");
  }

  return `${pathname || "/"}${hash}`;
}

const localePathPrefixes = new Set<string>(locales);

function stripLocalePrefix(url: string): string {
  const hashIndex = url.indexOf("#");
  const pathname = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const parts = pathname.split("/");

  if (parts.length > 2 && localePathPrefixes.has(parts[1] ?? "")) {
    return `/${parts.slice(2).join("/")}${hash}`;
  }

  return url;
}

export function normalizeDocsSearchResult(
  data: PagefindResultData,
): DocsSearchResult {
  const subResult = data.sub_results?.find((item) => item.excerpt || item.url);
  const title = subResult?.title || data.meta?.title || "Docs";
  const excerptHtml = subResult?.excerpt || data.excerpt || "";
  const plainExcerpt = subResult?.plain_excerpt || data.plain_excerpt || "";

  return {
    href: stripLocalePrefix(normalizePagefindUrl(subResult?.url || data.url)),
    title,
    section: data.meta?.section,
    excerptHtml,
    plainExcerpt,
  };
}

export function nextDocsSearchIndex({
  currentIndex,
  direction,
  resultCount,
}: {
  currentIndex: number;
  direction: "next" | "previous";
  resultCount: number;
}): number {
  if (resultCount <= 0) return -1;
  if (direction === "next") {
    return (Math.max(currentIndex, -1) + 1) % resultCount;
  }
  return (currentIndex <= 0 ? resultCount : currentIndex) - 1;
}
