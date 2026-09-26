///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Matches a filesystem entry's basename (extension already stripped for files) against the
 * single-dynamic-segment convention: exactly one `[name]` for the whole basename. Rejects empty
 * names and malformed/multiple bracket groups (e.g. `"[]"`, `"[a][b]"`, `"[a/b]"`).
 */
const DYNAMIC_SEGMENT_NAME_RE = /^\[([^/[\]]+)\]$/;
export function parseDynamicSegmentName(basename: string): string | null {
    const match = DYNAMIC_SEGMENT_NAME_RE.exec(basename);
    return match ? match[1] : null;
}

/**
 * Matches a `:name`-style route template (e.g. `"/pets/:id/reviews/:reviewId"`) against a
 * concrete request path (e.g. `"/pets/42/reviews/7"`), segment by segment. Literal segments must
 * match exactly once the request's segment is URI-decoded (a page file named `café.tsx` is `/caf%C3%A9` in a URL);
 * `:name` segments match (and capture, URI-decoded) anything. Returns `null` on any
 * mismatch, including a differing segment count — there is no catch-all/rest support, matching
 * `@rapidrest/service-core`'s own route-param convention (`:name` only, `req.params` is always
 * `Record<string, string>`).
 */
const PARAM_TOKEN_RE = /^:([^/]+)$/;

/** `decodeURIComponent()`, but a malformed escape is left as written instead of throwing. */
function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}
export function matchRouteTemplate(template: string, actualPath: string): Record<string, string> | null {
    const templateParts = template.split("/").filter(Boolean);
    const actualParts = actualPath.split("/").filter(Boolean);
    if (templateParts.length !== actualParts.length) return null;

    const params: Record<string, string> = {};
    for (let i = 0; i < templateParts.length; i++) {
        const paramMatch = PARAM_TOKEN_RE.exec(templateParts[i]);
        if (paramMatch) {
            try {
                params[paramMatch[1]] = decodeURIComponent(actualParts[i]);
            } catch {
                return null;
            }
        } else if (templateParts[i] !== decodeSegment(actualParts[i])) {
            return null;
        }
    }
    return params;
}

/** What `matchPathPattern()` found: the values the pattern's `:name` segments (and trailing `*`) captured, and the path it matched. */
export interface PathMatch {
    /** The captured values, URI-decoded. A trailing `*` is captured as `params["*"]` (the rest of the path, or `""`). */
    params: Record<string, string>;
    /** The part of the path the pattern matched: all of it for an exact match, its leading segments for a prefix one. */
    pathname: string;
}

/**
 * Matches a URL path against a pattern of literal segments, `:name` segments (which capture one segment each) and,
 * optionally, a final `*` (which matches the rest of the path, however many segments that is, including none) — the
 * patterns a link or a `useMatch()` names, like `/pets/:id` or `/settings/*`.
 *
 * With `end` (the default) the whole path has to match; without it the pattern only has to match the start of the path,
 * on whole segments (`/settings` matches `/settings/profile` but not `/settingsx`), as if it ended in `/*`. Trailing
 * slashes don't matter, and literal segments are compared as decoded (as in `matchRouteTemplate()`). Returns `null` when
 * the path doesn't match, or a captured value isn't valid percent-encoding.
 */
export function matchPathPattern(pattern: string, pathname: string, end: boolean = true): PathMatch | null {
    const patternParts = pattern.split("/").filter(Boolean);
    const actualParts = pathname.split("/").filter(Boolean);
    const wildcard = patternParts[patternParts.length - 1] === "*";
    if (wildcard) patternParts.pop();
    if (patternParts.length > actualParts.length) return null;
    if (end && !wildcard && patternParts.length !== actualParts.length) return null;

    const params: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
        const paramMatch = PARAM_TOKEN_RE.exec(patternParts[i]);
        if (paramMatch) {
            try {
                params[paramMatch[1]] = decodeURIComponent(actualParts[i]);
            } catch {
                return null;
            }
        } else if (patternParts[i] !== decodeSegment(actualParts[i])) {
            return null;
        }
    }
    if (wildcard) {
        try {
            params["*"] = actualParts.slice(patternParts.length).map((part) => decodeURIComponent(part)).join("/");
        } catch {
            return null;
        }
    }
    return { params, pathname: "/" + actualParts.slice(0, wildcard ? actualParts.length : patternParts.length).join("/") };
}

/**
 * The inverse of `matchRouteTemplate()`: substitutes every `:name` token in a route template with
 * the (URI-encoded) value from `params`. Returns `null` — never a partially-filled path — if any
 * token has no corresponding entry in `params`, so a `getStaticPaths()` result missing a required
 * param is silently skipped by the caller rather than producing a broken URL.
 */
export function fillRouteTemplate(template: string, params: Record<string, string>): string | null {
    const filled: string[] = [];
    for (const segment of template.split("/")) {
        const paramMatch = PARAM_TOKEN_RE.exec(segment);
        if (!paramMatch) {
            filled.push(segment);
            continue;
        }
        const value = params[paramMatch[1]];
        if (value === undefined || value === null) return null;
        filled.push(encodeURIComponent(value));
    }
    return filled.join("/");
}

/**
 * Set to `"true"` by `runStaticExport()` (`static.ts`) for the lifetime of the dedicated server it
 * boots to crawl for a static export, and read by `ReactRoute` to gate the `STATIC_PATHS_ROUTE`
 * endpoint. Shared here (rather than duplicated as a literal in both files) so the two stay in
 * sync — the endpoint must never be reachable in a normal deployment, only during export, since it
 * runs developer-authored `getStaticPaths()` code (page or `@ReactService`) that may hit a
 * database; permanently exposing that to anonymous callers would be a real, externally-reachable
 * resource-exhaustion/information-disclosure surface, not just a build-time convenience.
 */
export const STATIC_EXPORT_ENV_VAR = "RAPIDREACT_STATIC_EXPORT";

/**
 * Path of `ReactRoute`'s static-path-enumeration endpoint (mount-prefix-relative, like
 * `DEV_RELOAD_PATH`). Only active while `process.env[STATIC_EXPORT_ENV_VAR] === "true"`. Shared
 * with `static.ts` so the route string itself isn't duplicated between the reader and the writer.
 */
export const STATIC_PATHS_ROUTE = "/__rapidrest__/static-paths";
