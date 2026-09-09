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
 * match exactly; `:name` segments match (and capture, URI-decoded) anything. Returns `null` on any
 * mismatch, including a differing segment count — there is no catch-all/rest support, matching
 * `@rapidrest/service-core`'s own route-param convention (`:name` only, `req.params` is always
 * `Record<string, string>`).
 */
const PARAM_TOKEN_RE = /^:([^/]+)$/;
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
        } else if (templateParts[i] !== actualParts[i]) {
            return null;
        }
    }
    return params;
}
