///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { matchRouteTemplate } from "./routeMatch.js";

/*
 * The client-side router's logic, with nothing in it that touches the DOM, `window`, `fetch` or React: everything the
 * browser has to be asked for goes through `RouterPlatform`, so this can be exercised (and trusted) without one. The
 * browser glue that supplies a real platform is in `router.ts`.
 *
 * The model is a progressive enhancement of server-side rendering, never a replacement for it. A page always renders
 * on the server first; the router only takes over *navigating between* pages, and whenever it isn't certain it can do
 * that faithfully — an unknown route, a redirect, an error page, a response that isn't what it expected, any failure
 * at all — it does the one thing that always works, and lets the browser load the URL the ordinary way.
 */

/**
 * Sent on a navigation request to ask the server for the page's data as JSON instead of its rendered HTML. The same
 * URL serves both, so responses must `Vary` on it.
 */
export const NAVIGATION_HEADER = "X-Rapidrest-Navigation";

/** The id of the `<script type="application/json">` element the server puts a `RouterConfig` in. */
export const ROUTER_CONFIG_ID = "rapidrest-router";

/** One page the client can navigate to without a full load. */
export interface ClientRoute {
    /** The route's `:name`-style template, e.g. `/pets/:id` (relative to the mount prefix). */
    template: string;
    /** Loads the page's module, whose default export is its component. */
    load: () => Promise<{ default: any }>;
}

/** What the server tells the client about the page it just rendered. */
export interface RouterConfig {
    /** The mount prefix (e.g. `/admin`), or `""`. Route templates are relative to it. */
    prefix: string;
    /** The template of the route this page is. */
    route: string;
    /** Element id of the hydration root. */
    rootId: string;
    /** Element id of the serialized props `<script>`. */
    propsId: string;
    /**
     * The stylesheets the server put in the page for it. They're the page's to take out again when it's navigated away
     * from (whichever of them the next page needs stays), unlike a layout's own `<link>`s, which are never touched.
     */
    css?: string[];
}

/** The JSON a navigation request is answered with. */
export interface PagePayload {
    /** The template of the route the server resolved the URL to; must be the one the client resolved it to too. */
    route: string;
    /** The page's props, exactly as they'd have been embedded for hydration. */
    props: any;
    /** Stylesheets the page needs, as URLs. */
    css: string[];
    /**
     * The document's `<title>` as the layout renders it for this page's props, when there is a layout with one. The
     * layout itself isn't rendered again by the browser, so this is what keeps the tab's title following the page.
     */
    title?: string;
}

/** A page that's ready to be put on screen. */
export interface RenderedPage {
    component: any;
    props: any;
    url: URL;
    params: Record<string, string>;
    route: string;
}

export interface NavigateOptions {
    /** Replace the current history entry rather than adding one. */
    replace?: boolean;
    /** Set to `false` to leave the scroll position alone (default: to the top, or to the URL's `#hash` target). */
    scroll?: boolean;
}

/** Everything the router needs from the browser. */
export interface RouterPlatform {
    /** The document's current URL. */
    location(): URL;
    /** Asks the server for the page at `url` as JSON; `null` when it didn't answer with a page payload. */
    fetchPayload(url: URL, signal: AbortSignal): Promise<PagePayload | null>;
    /** Resolves once every one of `hrefs` is loaded as a stylesheet (adding the ones that aren't). */
    ensureStyles(hrefs: string[]): Promise<void>;
    /** Removes the stylesheets of pages already left that the page now showing (which needs `keep`) doesn't need. */
    pruneStyles(keep: string[]): void;
    /** Sets the document's title. */
    setTitle(title: string): void;
    /** Puts `page` on screen, synchronously (the new URL is already current when this is called). */
    render(page: RenderedPage): void;
    /** Records the scroll position on the current history entry, so going back can return to it. */
    saveScroll(): void;
    /** Adds (`"push"`) or replaces (`"replace"`) a history entry for `url`. */
    commitHistory(url: URL, mode: "push" | "replace"): void;
    /** After a render: restores the entry's saved scroll position, or scrolls to `url`'s hash target / the top. */
    settle(url: URL, options: { restore: boolean; scroll: boolean }): void;
    /** Loads `url` the ordinary way. */
    hardNavigate(url: string): void;
}

/** How long a prefetched page stays usable, in milliseconds. */
export const PREFETCH_TTL_MS = 30_000;

/**
 * Orders two route templates by specificity, so that where several match one path the most specific is tried first:
 * at the first segment where they differ, a literal outranks a `:param`. This is the precedence the server's
 * file-based resolution applies too (a literal directory/file beats a `[dynamic]` sibling).
 */
export function compareTemplates(a: string, b: string): number {
    const aParts = a.split("/").filter(Boolean);
    const bParts = b.split("/").filter(Boolean);
    const shared = Math.min(aParts.length, bParts.length);
    for (let i = 0; i < shared; i++) {
        const aParam = aParts[i].startsWith(":");
        const bParam = bParts[i].startsWith(":");
        if (aParam !== bParam) return aParam ? 1 : -1;
    }
    return aParts.length - bParts.length;
}

/** A copy of `routes` in the order they should be tried (most specific first; otherwise as given). */
export function sortRoutes(routes: ClientRoute[]): ClientRoute[] {
    return [...routes].sort((x, y) => compareTemplates(x.template, y.template));
}

/**
 * `pathname` relative to the mount `prefix` (`/admin/users` → `/users`, `/admin` → `/`), or `null` if it isn't under
 * the prefix at all. Only whole path segments count: `/adminx` is not under `/admin`.
 */
export function stripPrefix(pathname: string, prefix: string): string | null {
    if (!prefix) return pathname;
    if (pathname === prefix) return "/";
    return pathname.startsWith(prefix + "/") ? pathname.slice(prefix.length) : null;
}

/** The first of `routes` (already sorted) that serves `pathname`, with the values its `:params` captured. */
export function matchClientRoute(
    routes: ClientRoute[],
    pathname: string,
    prefix: string,
): RouteMatch | null {
    const relative = stripPrefix(pathname, prefix);
    if (relative === null) return null;
    for (const route of routes) {
        const params = matchRouteTemplate(route.template, relative);
        if (params) return { route, params };
    }
    return null;
}

/** `href` resolved against `base`, if it's an `http(s)` URL on the same origin — otherwise `null`. */
export function resolveTarget(href: string, base: string): URL | null {
    let url: URL;
    let baseUrl: URL;
    try {
        baseUrl = new URL(base);
        url = new URL(href, baseUrl);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === baseUrl.origin ? url : null;
}

/**
 * Whether going from `current` to `target` only moves to a `#fragment` of the page already showing — which the browser
 * does on its own, with no navigation to speak of.
 */
export function isHashChange(target: URL, current: URL): boolean {
    return (
        target.pathname === current.pathname &&
        target.search === current.search &&
        target.hash !== "" &&
        target.hash !== current.hash
    );
}

/** The parts of a `click` event `isInterceptableClick()` reads. */
export interface ClickLike {
    defaultPrevented: boolean;
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
}

/** The parts of an `<a>` element `isInterceptableClick()` reads. */
export interface AnchorLike {
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
}

/**
 * Whether a click on `anchor` is an ordinary "follow this link" click the router may take over: a plain primary-button
 * click that nothing has handled yet, on a link with a destination, that isn't opening somewhere else (`target`), being
 * downloaded, marked as leaving the site (`rel="external"`), or opted out (`data-router-ignore`). Anything else is the
 * browser's to handle — it's how "open in new tab" and the like keep working.
 */
export function isInterceptableClick(event: ClickLike, anchor: AnchorLike | null): boolean {
    if (!anchor || event.defaultPrevented || event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (anchor.getAttribute("href") === null) return false;
    const target = anchor.getAttribute("target");
    if (target && target !== "_self") return false;
    if (anchor.hasAttribute("download") || anchor.hasAttribute("data-router-ignore")) return false;
    return !(anchor.getAttribute("rel") ?? "").split(/\s+/).includes("external");
}

/** Whether `value` is a well-formed `PagePayload`. */
export function isPagePayload(value: any): value is PagePayload {
    return (
        !!value &&
        typeof value === "object" &&
        typeof value.route === "string" &&
        "props" in value &&
        Array.isArray(value.css) &&
        value.css.every((href: unknown) => typeof href === "string") &&
        (value.title === undefined || typeof value.title === "string")
    );
}

/** A page matched to a URL: the route, and the values its `:params` captured. */
export interface RouteMatch {
    route: ClientRoute;
    params: Record<string, string>;
}

interface Prefetched {
    at: number;
    /** The signal the entry's request was made with; once aborted the entry can never produce a page. */
    signal: AbortSignal;
    payload: Promise<PagePayload | null>;
    module: Promise<{ default: any }>;
}

/**
 * The navigation state machine: decides what can be navigated to without a full load, loads a page's module and its
 * data together, and puts it on screen — or, if anything about that isn't certain, has the browser load the URL the
 * ordinary way instead.
 */
export class Router {
    private readonly routes: ClientRoute[];
    private navigation = 0;
    private controller: AbortController | null = null;
    private readonly prefetched = new Map<string, Prefetched>();

    constructor(
        routes: ClientRoute[],
        private readonly prefix: string,
        private readonly platform: RouterPlatform,
        private readonly now: () => number = Date.now,
    ) {
        this.routes = sortRoutes(routes);
    }

    private static key(url: URL): string {
        return url.pathname + url.search;
    }

    private match(url: URL): RouteMatch | null {
        return matchClientRoute(this.routes, url.pathname, this.prefix);
    }

    /**
     * Whether `href` is something `navigate()` would handle on the client: on this origin, one of this app's pages, and
     * not merely a `#fragment` of the page already showing.
     */
    canHandle(href: string): boolean {
        const current = this.platform.location();
        const target = resolveTarget(href, current.href);
        return !!target && !isHashChange(target, current) && !!this.match(target);
    }

    /**
     * Starts fetching the page at `href` (its module and its data) so that navigating to it shortly after is quick.
     * Quietly does nothing for anything `navigate()` wouldn't handle, and for a page fetched within the last
     * `PREFETCH_TTL_MS`.
     */
    prefetch(href: string): void {
        const target = resolveTarget(href, this.platform.location().href);
        const match = target && this.match(target);
        if (!target || !match) return;
        const key = Router.key(target);
        const existing = this.prefetched.get(key);
        if (existing && this.now() - existing.at < PREFETCH_TTL_MS) return;
        this.start(target, match.route, new AbortController().signal, key);
    }

    private start(url: URL, route: ClientRoute, signal: AbortSignal, key: string): Prefetched {
        const entry: Prefetched = {
            at: this.now(),
            signal,
            payload: this.platform.fetchPayload(url, signal),
            module: route.load(),
        };
        this.prefetched.set(key, entry);
        // A failed fetch mustn't be remembered as if it were a page — and mustn't be reported as unhandled when nobody
        // is waiting on it (a prefetch) either; whoever *is* waiting handles it themselves.
        const forget = () => {
            if (this.prefetched.get(key) === entry) this.prefetched.delete(key);
        };
        entry.payload.catch(forget);
        entry.module.catch(forget);
        return entry;
    }

    /**
     * Navigates to `to`. Resolves `true` when that was done without a full page load (or was overtaken by a newer
     * navigation, which is now what's being done instead) and `false` when it was left to the browser to load the
     * page the ordinary way.
     */
    async navigate(to: string, options: NavigateOptions = {}): Promise<boolean> {
        const current = this.platform.location();
        const target = resolveTarget(to, current.href);
        if (!target) return this.fallBack(to);
        const match = this.match(target);
        if (!match) return this.fallBack(target.href);

        const mode = options.replace || target.href === current.href ? "replace" : "push";
        return this.go(target, match, mode, options.scroll !== false, false);
    }

    /** Shows the page for the document's URL after the browser moved through history (back/forward). */
    async popstate(): Promise<boolean> {
        const target = this.platform.location();
        const match = this.match(target);
        if (!match) return this.fallBack(target.href);
        return this.go(target, match, null, true, true);
    }

    private fallBack(url: string): false {
        this.platform.hardNavigate(url);
        return false;
    }

    private async go(
        target: URL,
        match: RouteMatch,
        mode: "push" | "replace" | null,
        scroll: boolean,
        restore: boolean,
    ): Promise<boolean> {
        const token = ++this.navigation;
        this.controller?.abort();
        const controller = (this.controller = new AbortController());
        const superseded = () => token !== this.navigation;

        try {
            const key = Router.key(target);
            const cached = this.prefetched.get(key);
            const entry =
                cached && !cached.signal.aborted && this.now() - cached.at < PREFETCH_TTL_MS
                    ? cached
                    : this.start(target, match.route, controller.signal, key);
            const [payload, module] = await Promise.all([entry.payload, entry.module]);
            if (superseded()) return true;

            // Only a page the server agrees is the one the client thinks it is can be trusted to be what a full
            // load would show; anything else — an error page, a redirect, HTML where JSON was expected — is
            // rendered by the server, the ordinary way.
            if (!payload || payload.route !== match.route.template) return this.fallBack(target.href);

            await this.platform.ensureStyles(payload.css);
            if (superseded()) return true;

            // Going back or forward, the history entry is already the destination's, so what's on screen is not its
            // scroll position to save — saving it would overwrite the one about to be restored.
            if (!restore) this.platform.saveScroll();
            if (mode) this.platform.commitHistory(target, mode);
            this.platform.render({
                component: module.default,
                props: payload.props,
                url: target,
                params: match.params,
                route: match.route.template,
            });
            this.platform.settle(target, { restore, scroll });
            if (payload.title !== undefined) this.platform.setTitle(payload.title);
            this.platform.pruneStyles(payload.css);
            return true;
        } catch {
            // Overtaken while it failed (its request was aborted, most likely): not this navigation's problem any more.
            return superseded() ? true : this.fallBack(target.href);
        } finally {
            this.prefetched.delete(Router.key(target));
        }
    }
}

/** The name of an app's router entry among the Vite build's inputs, under the app's directory (`apps/www/__router`). */
export const ROUTER_ENTRY_NAME = "__router";
