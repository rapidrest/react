///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { type ComponentType } from "react";
import { hydrateRoot } from "react-dom/client";

/**
 * Reads the serialized props injected by ReactRoute into the page.
 * @param propsId - id of the `<script type="application/json">` element. Default: `"react-props"`.
 */
export function getHydrationProps(propsId = "react-props"): any {
    if (typeof document === "undefined") return undefined;
    // Among the JSON scripts, not by `getElementById` (see `readJsonScript()`).
    const el = Array.from(document.querySelectorAll('script[type="application/json"]')).find((script) => script.id === propsId);
    if (!el) return undefined;
    try {
        return JSON.parse(el.textContent);
    } catch {
        return undefined;
    }
}

/**
 * Hydrates a server-rendered React page.
 * Reads serialized props from the DOM, then calls `hydrateRoot` on the root container.
 *
 * @param Component - The same component rendered on the server.
 * @param rootId    - id of the hydration root element. Default: `"react-root"`.
 * @param propsId   - id of the serialized props element. Default: `"react-props"`.
 */
export function hydrateRoute(
    Component: ComponentType<any>,
    rootId = "react-root",
    propsId = "react-props"
): void {
    if (typeof document === "undefined") return;
    const container = document.getElementById(rootId);
    if (!container) {
        console.error(`[rapidrest/react] Hydration root element #${rootId} not found in DOM.`);
        return;
    }
    const props = getHydrationProps(propsId);
    hydrateRoot(container, React.createElement(Component, props));
}

export { mountRouter, startRouter } from "./router.js";
export type { MountRouterOptions, StartRouterOptions } from "./router.js";
export { shouldSaveData, whenIdle } from "./idle.js";
export {
    createSearchParams,
    isLinkActive,
    Link,
    NavLink,
    RouterProvider,
    useBlocker,
    useLocation,
    useMatch,
    useNavigationEffects,
    useParams,
    usePathname,
    useRouter,
    useSearchParams,
} from "./routerContext.js";
export type {
    BlockerOptions,
    LinkProps,
    NavLinkProps,
    NavLinkState,
    RouterApi,
    RouterLocation,
    SearchParamsInit,
    SetSearchParams,
    SetSearchParamsOptions,
    UseRouter,
} from "./routerContext.js";
export type { PathMatch } from "./routeMatch.js";
export type { ClientRoute, NavigateOptions, NavigationEffects, PrefetchOptions } from "./routerCore.js";
