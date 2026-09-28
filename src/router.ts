///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Component, type ComponentType, createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, hydrateRoot } from "react-dom/client";
import { type ConnectionNavigator, type IdleWindow, shouldSaveData, whenIdle } from "./idle.js";
import { matchRouteTemplate } from "./routeMatch.js";
import { RouterProvider } from "./routerContext.js";
import {
    type ClientRoute,
    type HistoryEntry,
    isInterceptableAnchor,
    isInterceptableClick,
    isPagePayload,
    matchClientRoute,
    NAVIGATION_HEADER,
    type NavigationEffects,
    type PageUpdate,
    type PagePayload,
    type RenderedPage,
    Router,
    ROUTER_CONFIG_ID,
    type RouterConfig,
    type RouterPlatform,
    sortRoutes,
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

/**
 * How long the live region is left empty before the announcement is put in it, in milliseconds: a screen reader only
 * speaks a change, so an announcement identical to the last one has to be preceded by nothing.
 */
export const ANNOUNCE_DELAY_MS = 50;

/** Hides an element from sight without hiding it from a screen reader (`display: none` would do both). */
const VISUALLY_HIDDEN =
    "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0";

/** What the router uses of `window`. */
export interface WindowLike extends Partial<Pick<IdleWindow, "requestIdleCallback" | "cancelIdleCallback">> {
    location: { href: string; assign(url: string): void; reload(): void };
    history: {
        state: any;
        length: number;
        scrollRestoration?: string;
        pushState(state: any, title: string, url: string): void;
        replaceState(state: any, title: string, url?: string): void;
        go(delta: number): void;
    };
    navigator?: ConnectionNavigator;
    scrollX: number;
    scrollY: number;
    scrollTo(x: number, y: number): void;
    fetch(url: string, init: any): Promise<Response>;
    confirm(message: string): boolean;
    setTimeout(handler: () => void, ms: number): any;
    clearTimeout(handle: any): void;
    addEventListener(type: string, handler: (event: any) => void): void;
    removeEventListener(type: string, handler: (event: any) => void): void;
    sessionStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

/** What the router uses of `document`. */
export interface DocumentLike {
    head: { appendChild(node: any): any };
    body: { appendChild(node: any): any };
    readyState: string;
    createElement(tag: string): any;
    getElementById(id: string): any;
    querySelector(selector: string): any;
    querySelectorAll(selector: string): ArrayLike<any>;
    title: string;
    addEventListener(type: string, handler: (event: any) => void): void;
}

/**
 * Reads and parses the JSON in the `<script type="application/json">` with the given id, or `undefined`. Looked up among
 * the JSON scripts, not by `getElementById`, which answers with the first element of that id in the document — any that
 * page content with a chosen `id` (a comment's anchor named `react-props`) puts ahead of the server's own.
 */
export function readJsonScript(doc: Pick<DocumentLike, "querySelectorAll">, id: string): any {
    const element = Array.from(doc.querySelectorAll('script[type="application/json"]')).find((script) => script.id === id);
    if (!element) return undefined;
    try {
        return JSON.parse(element.textContent);
    } catch {
        return undefined;
    }
}

/** What `createBrowserPlatform()` is given besides the browser: the React side of what the platform has to tell. */
export interface PlatformHooks {
    /** The `NavigationEffects` in force (default: none, so focus goes to the container and the page scrolls to the top). */
    effects?: () => NavigationEffects;
    /** Re-renders the page on screen, keeping it, with a changed location or props. */
    update?: (change: PageUpdate) => void;
    /** Also mark the container `data-router-pending` and `aria-busy` while a navigation is under way. */
    pendingAttributes?: boolean;
}

/**
 * Builds the `RouterPlatform` for a real browser. `render` puts a page on screen; it's given rather than built here
 * because the React root it renders into has to exist (and be hydrated) before there's anything to render into.
 */
export function createBrowserPlatform(
    win: WindowLike,
    doc: DocumentLike,
    container: {
        focus(options?: any): void;
        setAttribute(name: string, value: string): void;
        removeAttribute(name: string): void;
        style: { outline: string };
    },
    render: (page: RenderedPage) => void,
    initialStyles: string[] = [],
    hooks: PlatformHooks = {},
): RouterPlatform {
    const { effects = (): NavigationEffects => ({}), update = () => undefined, pendingAttributes = false } = hooks;
    const absolute = (href: string) => new URL(href, win.location.href).href;
    // The stylesheets that belong to pages (the server's for the first one, and each one added since), as opposed to a
    // layout's own, which nothing here has any business removing.
    const pageStyles = new Set(initialStyles.map(absolute));

    // The container is what gets focus after a navigation (so a screen reader's cursor moves to the new page, as it
    // would after a load); it's not something to tab to, and shouldn't be outlined as if it were.
    container.setAttribute("tabindex", "-1");
    container.style.outline = "none";
    const focusPage = () => container.focus({ preventScroll: true });

    /** The element the app asked focus to go to, if it asked for one and it's there. */
    const focusTarget = (focus: NavigationEffects["focus"]): any => {
        try {
            if (typeof focus === "string") return doc.querySelector(focus);
            return typeof focus === "function" ? focus() : null;
        } catch {
            // A selector that isn't one: as good as one that matches nothing.
            return null;
        }
    };

    /** The polite live region announcements go in, made when the first one is due, and outside the React tree so that it's never re-rendered away. */
    let region: any = null;
    const liveRegion = () => {
        if (!region) {
            region = doc.createElement("div");
            region.setAttribute("role", "status");
            region.setAttribute("aria-live", "polite");
            region.setAttribute("aria-atomic", "true");
            region.style.cssText = VISUALLY_HIDDEN;
            doc.body.appendChild(region);
        }
        return region;
    };

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

        update,

        setPending(pending: boolean) {
            if (pendingAttributes) {
                if (pending) {
                    container.setAttribute("data-router-pending", "true");
                    container.setAttribute("aria-busy", "true");
                } else {
                    container.removeAttribute("data-router-pending");
                    container.removeAttribute("aria-busy");
                }
            }
        },

        saveScroll() {
            win.history.replaceState({ ...(win.history.state ?? {}), rrScroll: { x: win.scrollX, y: win.scrollY } }, "");
        },

        commitHistory(url: URL, mode: "push" | "replace", shallow: boolean = false) {
            // Each entry records where in the session history it is (`rrIndex`), so that a back or forward the user then
            // refuses can be undone by going the same distance the other way. An entry from before the router was there
            // has none: it's taken to be the last one, which is what a page that was just loaded is.
            const state = win.history.state;
            const here: number = typeof state?.rrIndex === "number" ? state.rrIndex : win.history.length - 1;
            const entry = shallow ? { rrShallow: true } : {};
            if (mode === "push") {
                if (typeof state?.rrIndex !== "number") win.history.replaceState({ ...(state ?? {}), rrIndex: here }, "");
                win.history.pushState({ rrIndex: here + 1, ...entry }, "", url.href);
            } else {
                win.history.replaceState({ rrIndex: here, ...entry }, "", url.href);
            }
        },

        historyEntry(): HistoryEntry {
            const state = win.history.state;
            return { index: typeof state?.rrIndex === "number" ? state.rrIndex : null, shallow: state?.rrShallow === true };
        },

        historyGo(delta: number) {
            win.history.go(delta);
        },

        settle(url: URL, { restore, scroll }: { restore: boolean; scroll: boolean }) {
            const { scroll: scrolling, focus } = effects();
            // `scroll: false` in the effects is the app saying the scroll position is its own to look after.
            if (scrolling !== false) {
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
                    else if (scrolling !== "preserve") win.scrollTo(0, 0);
                }
            }
            if (focus === false) return;
            const element = focusTarget(focus);
            if (!element) {
                focusPage();
                return;
            }
            // A heading or a region isn't focusable until it's given a tabindex; -1 lets script focus it without making it a tab stop.
            if (element.hasAttribute && !element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
            element.focus({ preventScroll: true });
        },

        announce(url: URL) {
            const text = effects().announce?.({ title: doc.title, pathname: url.pathname });
            if (!text) return;
            const live = liveRegion();
            live.textContent = "";
            win.setTimeout(() => {
                live.textContent = text;
            }, ANNOUNCE_DELAY_MS);
        },

        confirm(message: string) {
            return win.confirm(message);
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

/** What `startRouter()` can be told. The entry `createViteConfig({ router })` generates passes the JSON-able ones from there. */
export interface StartRouterOptions {
    /**
     * The app's persistent shell, the default export of its `_shell.tsx`: rendered around every page, and kept mounted as
     * the pages are swapped in inside it. Used only when the server rendered it around the page too (so that what's
     * hydrated is what the markup holds).
     */
    shell?: ComponentType<any>;
    /** What happens after a page navigation, for the whole app: where focus goes, how the page scrolls, what's announced. `useNavigationEffects()` overrides it. */
    effects?: NavigationEffects;
    /** Mark the root `data-router-pending` and `aria-busy="true"` while a navigation is in flight. Default `false`. */
    pendingAttributes?: boolean;
    /** Warm pages before they're asked for. */
    prefetch?: {
        /** URLs (mount prefix included, as in a link's `href`) to prefetch once the browser is idle after the page has loaded, unless the user has asked to save data. */
        idle?: string[];
        /** Fetch these pages' data too, not only their code. Default `false`: the server is only asked for what a click asks it for. */
        data?: boolean;
        /**
         * Also warm the page (its code and its data) of any plain `<a href>` the router would take over, when it's pointed at,
         * pressed on or focused, as a `Link` does for itself. Default `false`, as it has the server work out the props of every
         * link the pointer passes over; `data-router-prefetch="false"` on a link leaves it out.
         */
        links?: boolean;
    };
}

/** What's on screen: the page (with the location it's at), and the key that makes a page a new instance. */
interface Screen {
    page: RenderedPage;
    key: number;
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
 * With an app shell (`options.shell`), that is what's hydrated — the shell around the page, as one root — and what stays
 * mounted: a navigation re-renders the shell's `children` with the new page, and only the page is a new instance.
 *
 * @returns The `Router`, or `undefined` when there's nothing to start (no DOM, or the page isn't a router page).
 */
export async function startRouter(
    routes: ClientRoute[],
    options: StartRouterOptions = {},
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
    // The shell is rendered on the client if, and only if, the server rendered it: hydrating a tree that isn't the one the markup is of would fail.
    if (config.shell && !options.shell) {
        console.error("[rapidrest/react] The server rendered the app's shell (_shell.tsx), but the client build has none: rebuild the client with createViteConfig({ router: true }).");
        return undefined;
    }
    const shell = config.shell ? options.shell : undefined;

    let root: ReturnType<typeof hydrateRoot>;
    let router!: Router;
    let screen!: Screen;

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

    // What the server rendered never has a `#fragment` (it isn't sent), so that's what's hydrated; the real one follows once it has hydrated.
    let onMounted: (() => void) | undefined;
    const element = () => {
        const { page, key } = screen;
        // Keyed, so that a page that failed doesn't leave the next one showing nothing — and so that every navigation
        // is a new instance of its page. Only the page: whatever is above it (the shell) is the same element each time.
        const boundary = createElement(RouteBoundary, { key, onError: recover }, createElement(page.component, page.props));
        return createElement(
            RouterProvider,
            {
                location: { pathname: page.url.pathname, search: page.url.search, hash: page.url.hash, params: page.params, route: page.route },
                api: router,
                onMounted,
            },
            // The shell has a boundary of its own so that it failing is the shell's failure, not a page's; and the page's is
            // inside it, so that a page failing leaves the shell mounted.
            shell ? createElement(RouteBoundary, { onError: recover }, createElement(shell, page.props, boundary)) : boundary,
        );
    };

    const platform = createBrowserPlatform(
        win,
        doc,
        container,
        (page) => {
            screen = { ...screen, page, key: screen.key + 1 };
            flushSync(() => root.render(element()));
        },
        config.css,
        {
            effects: () => router.effects(),
            update: (change) => {
                const params = change.params ?? screen.page.params;
                // A shallow change of the URL's params changes the page's `params` prop too, as a fetch of its props would have.
                const props =
                    change.props !== undefined ? change.props : change.params ? { ...screen.page.props, params } : screen.page.props;
                screen = { ...screen, page: { ...screen.page, url: change.url, params, props } };
                root.render(element());
            },
            pendingAttributes: options.pendingAttributes,
        },
    );
    router = new Router(routes, config.prefix, platform, Date.now, { route: route.template, effects: options.effects });

    const url = new URL(win.location.href);
    const params = matchRouteTemplate(route.template, stripPrefix(url.pathname, config.prefix) ?? url.pathname) ?? {};
    const module = await route.load();
    const props = readJsonScript(doc, config.propsId);
    const served = new URL(url.href);
    served.hash = "";
    screen = { page: { component: module.default, props, url: served, params, route: route.template }, key: 1 };
    if (url.hash) {
        onMounted = () => {
            onMounted = undefined;
            screen = { ...screen, page: { ...screen.page, url } };
            root.render(element());
        };
    }
    root = hydrateRoot(container, element());

    if (win.history.scrollRestoration !== undefined && options.effects?.scroll !== false) win.history.scrollRestoration = "manual";
    // The router keeps scroll positions itself (the browser's restoring is off, so it can restore a page it swapped in),
    // which includes the page this document loaded on: back to it from a full page load, or a reload, puts it back.
    const saved = win.history.state?.rrScroll;
    if (saved && options.effects?.scroll !== false) win.scrollTo(saved.x, saved.y);
    win.addEventListener("pagehide", () => platform.saveScroll());
    win.addEventListener("popstate", () => void router.popstate());
    // Closing the tab, reloading and following a link the router can't take are not the router's to ask about: the browser's own prompt is all there is.
    win.addEventListener("beforeunload", (event) => {
        if (!router.shouldBlockUnload()) return;
        event.preventDefault();
        event.returnValue = "";
    });
    const anchorOf = (event: Event) => (event.target as { closest?: (selector: string) => any } | null)?.closest?.("a") ?? null;
    doc.addEventListener("click", (event) => {
        const anchor = anchorOf(event);
        if (!isInterceptableClick(event, anchor)) return;
        const href: string = anchor.getAttribute("href");
        if (!router.canHandle(href)) return;
        event.preventDefault();
        void router.navigate(href, {
            replace: anchor.hasAttribute("data-router-replace"),
            ...(anchor.hasAttribute("data-router-shallow") ? { shallow: true } : {}),
        });
    });
    // Pointing at, pressing on or focusing a link is a sign it's about to be followed: get its page ready. A `Link` does that
    // itself (and opts out with `prefetch={false}`); for the plain `<a>` an app has, it's something to ask for, as it costs
    // the server the page's props for every link the pointer passes over.
    if (options.prefetch?.links) {
        const warm = (event: Event) => {
            const anchor = anchorOf(event);
            if (!anchor || !isInterceptableAnchor(anchor) || anchor.getAttribute("data-router-prefetch") === "false") return;
            router.prefetch(anchor.getAttribute("href"));
        };
        for (const type of ["pointerover", "pointerdown", "focusin"]) doc.addEventListener(type, warm);
    }

    const idle = options.prefetch?.idle ?? [];
    if (idle.length > 0 && !shouldSaveData(win.navigator)) {
        whenIdle(() => idle.forEach((href) => router.prefetch(href, { data: options.prefetch?.data === true })), win, doc);
    }

    return router;
}

/** What `mountRouter()` can be told. */
export interface MountRouterOptions {
    /** Element id of the (empty) container to render into. Unlike `startRouter()`'s hydration root, nothing is expected to be in it already. */
    rootId: string;
    /** The mount prefix (e.g. `/admin`) route templates are relative to. Default `""`, none. */
    prefix?: string;
    /**
     * The app's persistent shell, the default export of its `_shell.tsx`: rendered around every page from the very first
     * render — there's no server-rendered markup it has to agree with, unlike `startRouter()`'s `shell`, which is only
     * rendered when the server rendered it too.
     */
    shell?: ComponentType<any>;
    /**
     * Supplies whatever props the matched route's component (and the shell, if any) needs for the page the URL is
     * mounting on: called once, with the matched route and the values its `:params` captured, before the route's module
     * is loaded. There's no server-rendered payload to read a first page's props from in a pure client-side mount, the
     * way `startRouter()` reads one out of the DOM — this is how a caller supplies the same thing. Left out, or
     * resolving to `undefined`, renders the page with no props, which is how `@rapidmx/web-client`'s own pages already
     * work: they fetch their data themselves once mounted, rather than needing it at bootstrap.
     */
    resolveProps?: (route: ClientRoute, params: Record<string, string>) => Promise<unknown>;
    /** What happens after a page navigation, for the whole app: where focus goes, how the page scrolls, what's announced. `useNavigationEffects()` overrides it. */
    effects?: NavigationEffects;
    /** Mark the root `data-router-pending` and `aria-busy="true"` while a navigation is in flight. Default `false`. */
    pendingAttributes?: boolean;
    /** Warm pages before they're asked for. Same as `StartRouterOptions.prefetch`. */
    prefetch?: StartRouterOptions["prefetch"];
}

/**
 * Mounts the router client-side-only, with no server-rendered HTML at all: for a host with no SSR of its own (an app
 * shell hosting `@rapidrest/react` pages in a native webview, say), rather than `startRouter()`'s hydration of markup a
 * `ReactRoute` server rendered. Matches `win.location` against `routes` itself — the same matching (`matchClientRoute()`,
 * `sortRoutes()`) the `Router` it returns already does for every navigation afterwards, so there's nothing of that to
 * duplicate here — and `ReactDOM.createRoot(rootEl).render(...)`s the result into `options.rootId`'s (empty) element,
 * rather than `hydrateRoot()`ing into one whose children are expected to already be there. Once mounted, the `Router`
 * returned is the same class, wired the same way, as `startRouter()`'s: the same `NavLink`, `useBlocker()`, shallow
 * navigation and prefetching, with nothing reimplemented for it.
 *
 * Reads no `#rapidrest-router` config and no serialized props `<script>` — see `options.resolveProps` for how the first
 * page's props are supplied instead.
 *
 * @returns The `Router`, or `undefined` when there's nothing to mount on (no DOM, no `options.rootId` element, or the
 * URL matches none of `routes`).
 */
export async function mountRouter(
    routes: ClientRoute[],
    options: MountRouterOptions,
    win: WindowLike | undefined = typeof window === "undefined" ? undefined : (window),
    doc: DocumentLike | undefined = typeof document === "undefined" ? undefined : (document),
): Promise<Router | undefined> {
    if (!win || !doc) return undefined;

    const container = doc.getElementById(options.rootId);
    if (!container) {
        console.error(`[rapidrest/react] The router has nothing to mount on: no #${options.rootId} element.`);
        return undefined;
    }

    const prefix = options.prefix ?? "";
    const url = new URL(win.location.href);
    const match = matchClientRoute(sortRoutes(routes), url.pathname, prefix);
    if (!match) {
        console.error(`[rapidrest/react] No client route matches "${url.pathname}".`);
        return undefined;
    }

    let root: ReturnType<typeof createRoot>;
    let router!: Router;
    let screen!: Screen;

    /** A page that crashed the client: there's no server to render it instead here, but a reload is at least a fresh start (once; see `RECOVERY_KEY`). */
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

    const element = () => {
        const { page, key } = screen;
        // Keyed, as `startRouter()`'s is, so every navigation is a new instance of its page, and a page that failed
        // doesn't leave the next one showing nothing.
        const boundary = createElement(RouteBoundary, { key, onError: recover }, createElement(page.component, page.props));
        return createElement(
            RouterProvider,
            { location: { pathname: page.url.pathname, search: page.url.search, hash: page.url.hash, params: page.params, route: page.route }, api: router },
            options.shell ? createElement(RouteBoundary, { onError: recover }, createElement(options.shell, page.props, boundary)) : boundary,
        );
    };

    const platform = createBrowserPlatform(
        win,
        doc,
        container,
        (page) => {
            screen = { ...screen, page, key: screen.key + 1 };
            flushSync(() => root.render(element()));
        },
        [],
        {
            effects: () => router.effects(),
            update: (change) => {
                const params = change.params ?? screen.page.params;
                const props =
                    change.props !== undefined ? change.props : change.params ? { ...screen.page.props, params } : screen.page.props;
                screen = { ...screen, page: { ...screen.page, url: change.url, params, props } };
                root.render(element());
            },
            pendingAttributes: options.pendingAttributes,
        },
    );
    router = new Router(routes, prefix, platform, Date.now, { route: match.route.template, effects: options.effects });

    const module = await match.route.load();
    const props = await options.resolveProps?.(match.route, match.params);
    // No server markup to render first: the URL's own #fragment (if any) is there from the start, unlike `startRouter()`,
    // which only has it once hydration has mounted.
    screen = { page: { component: module.default, props, url, params: match.params, route: match.route.template }, key: 1 };
    root = createRoot(container);
    root.render(element());

    if (win.history.scrollRestoration !== undefined && options.effects?.scroll !== false) win.history.scrollRestoration = "manual";
    const saved = win.history.state?.rrScroll;
    if (saved && options.effects?.scroll !== false) win.scrollTo(saved.x, saved.y);
    win.addEventListener("pagehide", () => platform.saveScroll());
    win.addEventListener("popstate", () => void router.popstate());
    win.addEventListener("beforeunload", (event) => {
        if (!router.shouldBlockUnload()) return;
        event.preventDefault();
        event.returnValue = "";
    });
    const anchorOf = (event: Event) => (event.target as { closest?: (selector: string) => any } | null)?.closest?.("a") ?? null;
    doc.addEventListener("click", (event) => {
        const anchor = anchorOf(event);
        if (!isInterceptableClick(event, anchor)) return;
        const href: string = anchor.getAttribute("href");
        if (!router.canHandle(href)) return;
        event.preventDefault();
        void router.navigate(href, {
            replace: anchor.hasAttribute("data-router-replace"),
            ...(anchor.hasAttribute("data-router-shallow") ? { shallow: true } : {}),
        });
    });
    if (options.prefetch?.links) {
        const warm = (event: Event) => {
            const anchor = anchorOf(event);
            if (!anchor || !isInterceptableAnchor(anchor) || anchor.getAttribute("data-router-prefetch") === "false") return;
            router.prefetch(anchor.getAttribute("href"));
        };
        for (const type of ["pointerover", "pointerdown", "focusin"]) doc.addEventListener(type, warm);
    }

    const idle = options.prefetch?.idle ?? [];
    if (idle.length > 0 && !shouldSaveData(win.navigator)) {
        whenIdle(() => idle.forEach((href) => router.prefetch(href, { data: options.prefetch?.data === true })), win, doc);
    }

    return router;
}
