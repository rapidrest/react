///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Component, createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { hydrateRoot } from "react-dom/client";
import { matchRouteTemplate } from "./routeMatch.js";
import { RouterProvider } from "./routerContext.js";
import {
    type ClientRoute,
    isInterceptableClick,
    isPagePayload,
    NAVIGATION_HEADER,
    type PagePayload,
    type RenderedPage,
    Router,
    ROUTER_CONFIG_ID,
    type RouterConfig,
    type RouterPlatform,
    stripPrefix,
} from "./routerCore.js";

/*
 * The browser glue for the router in `routerCore.ts`: turns `window`, `document` and `fetch` into a `RouterPlatform`,
 * hydrates the page the server rendered, and listens for the clicks and back/forward moves the router should handle.
 */

/** How long to wait for a page's stylesheet before showing the page without it, in milliseconds. */
export const STYLESHEET_TIMEOUT_MS = 5000;

/** The sessionStorage key remembering which URL a crash was already recovered from, so recovery can't loop. */
export const RECOVERY_KEY = "rapidrest-router-recovery";

/** What the router uses of `window`. */
export interface WindowLike {
    location: { href: string; assign(url: string): void; reload(): void };
    history: { state: any; scrollRestoration?: string; pushState(state: any, title: string, url: string): void; replaceState(state: any, title: string, url?: string): void };
    scrollX: number;
    scrollY: number;
    scrollTo(x: number, y: number): void;
    fetch(url: string, init: any): Promise<Response>;
    setTimeout(handler: () => void, ms: number): any;
    addEventListener(type: string, handler: (event: any) => void): void;
    sessionStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

/** What the router uses of `document`. */
export interface DocumentLike {
    head: { appendChild(node: any): any };
    createElement(tag: string): any;
    getElementById(id: string): any;
    querySelectorAll(selector: string): ArrayLike<{ href: string; remove(): void }>;
    title: string;
    addEventListener(type: string, handler: (event: any) => void): void;
}

/** Reads and parses the JSON in the `<script type="application/json">` with the given id, or `undefined`. */
export function readJsonScript(doc: Pick<DocumentLike, "getElementById">, id: string): any {
    const element = doc.getElementById(id);
    if (!element) return undefined;
    try {
        return JSON.parse(element.textContent);
    } catch {
        return undefined;
    }
}

/**
 * Builds the `RouterPlatform` for a real browser. `render` puts a page on screen; it's given rather than built here
 * because the React root it renders into has to exist (and be hydrated) before there's anything to render into.
 */
export function createBrowserPlatform(
    win: WindowLike,
    doc: DocumentLike,
    container: { focus(options?: any): void; setAttribute(name: string, value: string): void; style: { outline: string } },
    render: (page: RenderedPage) => void,
    initialStyles: string[] = [],
): RouterPlatform {
    const absolute = (href: string) => new URL(href, win.location.href).href;
    // The stylesheets that belong to pages (the server's for the first one, and each one added since), as opposed to a
    // layout's own, which nothing here has any business removing.
    const pageStyles = new Set(initialStyles.map(absolute));

    // The container is what gets focus after a navigation (so a screen reader's cursor moves to the new page, as it
    // would after a load); it's not something to tab to, and shouldn't be outlined as if it were.
    container.setAttribute("tabindex", "-1");
    container.style.outline = "none";
    const focusPage = () => container.focus({ preventScroll: true });

    return {
        location: () => new URL(win.location.href),

        async fetchPayload(url: URL, signal: AbortSignal): Promise<PagePayload | null> {
            const response = await win.fetch(url.href, {
                headers: { [NAVIGATION_HEADER]: "1", Accept: "application/json" },
                credentials: "same-origin",
                signal,
            });
            // A redirect means the URL isn't a page of its own; the browser should follow it itself. Anything that isn't
            // JSON is HTML from a server that doesn't do this (a static export, a proxy): it's the page, already.
            if (!response.ok || response.redirected) return null;
            if (!(response.headers.get("content-type") ?? "").includes("application/json")) return null;
            const body = await response.json();
            return isPagePayload(body) ? body : null;
        },

        ensureStyles(hrefs: string[]): Promise<void> {
            const present = new Set(Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).map((link) => link.href));
            const wanted = hrefs.map(absolute);
            wanted.forEach((href) => pageStyles.add(href));
            const loading = wanted
                .filter((href) => !present.has(href))
                .map(
                    (href) =>
                        new Promise<void>((resolve) => {
                            const link = doc.createElement("link");
                            link.rel = "stylesheet";
                            link.href = href;
                            // Loaded, failed, or taking too long: show the page either way, as a slow stylesheet
                            // shouldn't hold a navigation up for good.
                            link.onload = link.onerror = () => resolve();
                            win.setTimeout(resolve, STYLESHEET_TIMEOUT_MS);
                            doc.head.appendChild(link);
                        }),
                );
            return Promise.all(loading).then(() => undefined);
        },

        pruneStyles(keep: string[]) {
            const kept = new Set(keep.map(absolute));
            for (const link of Array.from(doc.querySelectorAll('link[rel="stylesheet"]'))) {
                if (pageStyles.has(link.href) && !kept.has(link.href)) link.remove();
            }
            for (const href of [...pageStyles]) if (!kept.has(href)) pageStyles.delete(href);
        },

        setTitle(title: string) {
            doc.title = title;
        },

        render,

        saveScroll() {
            win.history.replaceState({ ...(win.history.state ?? {}), rrScroll: { x: win.scrollX, y: win.scrollY } }, "");
        },

        commitHistory(url: URL, mode: "push" | "replace") {
            if (mode === "push") win.history.pushState({}, "", url.href);
            else win.history.replaceState({}, "", url.href);
        },

        settle(url: URL, { restore, scroll }: { restore: boolean; scroll: boolean }) {
            const saved = restore ? win.history.state?.rrScroll : undefined;
            if (saved) {
                win.scrollTo(saved.x, saved.y);
            } else if (scroll) {
                let target: { scrollIntoView(): void } | null = null;
                if (url.hash.length > 1) {
                    try {
                        target = doc.getElementById(decodeURIComponent(url.hash.slice(1)));
                    } catch {
                        // A malformed escape in the fragment: no such element, so scroll to the top like any other page.
                    }
                }
                if (target) target.scrollIntoView();
                else win.scrollTo(0, 0);
            }
            focusPage();
        },

        hardNavigate(url: string) {
            win.location.assign(url);
        },
    };
}

interface BoundaryProps {
    onError: (error: unknown) => void;
    children?: ReactNode;
}

/**
 * Catches a page throwing while it renders in the browser. The server can render the same URL, and will show its error
 * page if it can't either, so rather than leave a blank screen the router lets it try (see `recover()`).
 */
class RouteBoundary extends Component<BoundaryProps, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: unknown) {
        // (Through a cast: this package doesn't depend on React's types, so `props` isn't known to TypeScript here.)
        ((this as any).props as BoundaryProps).onError(error);
    }

    render() {
        return this.state.failed ? null : ((this as any).props as BoundaryProps).children;
    }
}

/**
 * Hydrates the page the server rendered and takes over navigating between the app's pages.
 *
 * Called by the entry module `createViteConfig({ router: true })` generates, with one `ClientRoute` per page file. The
 * server has put a `RouterConfig` (which route this is, the mount prefix, where the props are) in the page, so nothing
 * here needs configuring, and rendering is exactly what `hydrateRoute()` would have done for that page: the page is
 * hydrated into the same root, from the same props. It's only afterwards that clicking a link to another page loads
 * that page's module and data and swaps it in, rather than loading the whole document.
 *
 * @returns The `Router`, or `undefined` when there's nothing to start (no DOM, or the page isn't a router page).
 */
export async function startRouter(
    routes: ClientRoute[],
    win: WindowLike | undefined = typeof window === "undefined" ? undefined : (window),
    doc: DocumentLike | undefined = typeof document === "undefined" ? undefined : (document),
): Promise<Router | undefined> {
    if (!win || !doc) return undefined;

    const config: RouterConfig | undefined = readJsonScript(doc, ROUTER_CONFIG_ID);
    const container = config && doc.getElementById(config.rootId);
    if (!config || !container) {
        console.error(`[rapidrest/react] The router has nothing to start on: no #${ROUTER_CONFIG_ID} config, or no hydration root.`);
        return undefined;
    }
    const route = routes.find((candidate) => candidate.template === config.route);
    if (!route) {
        console.error(`[rapidrest/react] The server rendered route "${config.route}", which has no client route.`);
        return undefined;
    }

    let root: ReturnType<typeof hydrateRoot>;
    let router!: Router;
    let renders = 0;

    /** A page that crashed the client: have the server render it instead, unless that's already been tried. */
    const recover = (error: unknown) => {
        console.error("[rapidrest/react] A page failed to render in the browser:", error);
        try {
            if (win.sessionStorage.getItem(RECOVERY_KEY) === win.location.href) return;
            win.sessionStorage.setItem(RECOVERY_KEY, win.location.href);
        } catch {
            // No sessionStorage: reload without the loop protection, which is what would have happened anyway.
        }
        win.location.reload();
    };

    const element = (page: RenderedPage) =>
        createElement(
            RouterProvider,
            {
                location: { pathname: page.url.pathname, search: page.url.search, params: page.params, route: page.route },
                api: router,
            },
            // Keyed so a page that failed doesn't leave the next one showing nothing.
            createElement(RouteBoundary, { key: ++renders, onError: recover }, createElement(page.component, page.props)),
        );

    const platform = createBrowserPlatform(
        win,
        doc,
        container,
        (page) => flushSync(() => root.render(element(page))),
        config.css,
    );
    router = new Router(routes, config.prefix, platform);

    const url = new URL(win.location.href);
    const params = matchRouteTemplate(route.template, stripPrefix(url.pathname, config.prefix) ?? url.pathname) ?? {};
    const module = await route.load();
    const props = readJsonScript(doc, config.propsId);
    root = hydrateRoot(container, element({ component: module.default, props, url, params, route: route.template }));

    if (win.history.scrollRestoration !== undefined) win.history.scrollRestoration = "manual";
    win.addEventListener("popstate", () => void router.popstate());
    doc.addEventListener("click", (event) => {
        const anchor = (event.target as { closest?: (selector: string) => any } | null)?.closest?.("a") ?? null;
        if (!isInterceptableClick(event, anchor)) return;
        const href: string = anchor.getAttribute("href");
        if (!router.canHandle(href)) return;
        event.preventDefault();
        void router.navigate(href, { replace: anchor.hasAttribute("data-router-replace") });
    });

    return router;
}
