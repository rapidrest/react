///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Indicates that the decorated class is a React route service.
 *
 * A path may be a literal (`"/pets"`) or contain `:name` dynamic-segment tokens (`"/pets/:id"`),
 * matching a page's own bracketed file (`app/pets/[id].tsx`). A literal path always wins over a
 * dynamic template for the same request; among dynamic templates, the first one registered wins.
 * The template's own captured values are never used as `req.params` — those always come from the
 * page file's own bracket capture — so a service's param names don't strictly need to match the
 * page's, though they should by convention for `fetchProps` to make sense.
 *
 * @param paths The base path(s) of the app routes to apply the service for.
 */
export function ReactService(paths: string | string[]) {
    return function (target: Function) {
        let routePaths: string[] = Reflect.getMetadata("rrst:reactServicePaths", target.prototype) || [];
        routePaths = routePaths.concat(Array.isArray(paths) ? paths : [paths]);
        Reflect.defineMetadata("rrst:reactServicePaths", routePaths, target.prototype);
    };
}
