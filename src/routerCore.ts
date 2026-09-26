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

/**
 * The name (without extension) of the file in an app's directory that holds its persistent shell: `_shell.tsx`, next to
 * `_layout.tsx`. Its `_` prefix keeps it from being a page.
 */
export const SHELL_FILE_NAME = "_shell";

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
    /**
     * Whether the server rendered the app's shell (`_shell.tsx`) around the page. The client renders it around every page
     * it shows if, and only if, this is set — so what it hydrates always matches the markup it was given.
     */
    shell?: boolean;
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
     * The document's `<title>` for the page: what the page's own `title` export gives, else what the layout renders as
     * its `<title>` for the page's props. The layout itself isn't rendered again by the browser, so this is what keeps
     * the tab's title following the page.
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

/**
 * A change to the page on screen that keeps it — the same instance, with its state — instead of replacing it: a new
 * location (URL and params), and, when the props were fetched again, the new props. What isn't given stays as it was,
 * except that the page's `params` prop follows `params`.
 */
export interface PageUpdate {
    url: URL;
    params?: Record<string, string>;
    props?: any;
}

export interface NavigateOptions {
    /** Replace the current history entry rather than adding one. */
    replace?: boolean;
    /** Set to `false` to leave the scroll position alone (default: to the top, or to the URL's `#hash` target). */
    scroll?: boolean;
    /**
     * Keep the page instance (its state, its focus, its scroll position) instead of replacing it, when the destination is
     * another URL of the route that's on screen — only the location (`search`, `hash`, `params`) changes, and what reads
     * it re-renders. The page's props aren't fetched again unless `refetch` is set. For a destination that's a different
     * route this has no effect: that's an ordinary navigation. Neither `shallow` navigations nor `#fragment` ones ask a
     * blocker (`useBlocker()`) anything, as the page they'd lose work on is still there.
     */
    shallow?: boolean;
    /** The same as `shallow: true` when `false` (`remount: false`); ignored otherwise. */
    remount?: boolean;
    /** With `shallow`, fetch the page's props for the new URL from the server and give them to the page instance. */
    refetch?: boolean;
}

/** What `useNavigationEffects()`, and the `effects` option of `startRouter()`, control about what happens after a navigation. */
export interface NavigationEffects {
    /**
     * Where keyboard focus (and so a screen reader's cursor) goes when a new page is on screen, as a page load would have
     * put it back at the start of the document: a CSS selector (or a function that finds the element), or `false` to leave
     * it wherever it is. Default: the router's container, which is only focusable by script. The element gets
     * `tabindex="-1"` if it has none, so that it can take focus without becoming a tab stop. If the selector matches
     * nothing, the container is used.
     */
    focus?: string | (() => { focus(options?: any): void } | null) | false;
    /**
     * `"top"` (the default): a new page is scrolled to the top, or to its `#fragment`'s element, and going back or forward
     * restores where that entry was scrolled to. `"preserve"`: a new page is left where the scroll position is (still going
     * to a `#fragment`, and still restoring on back and forward). `false`: the router doesn't touch the scroll position at
     * all, for an app whose shell scrolls an element of its own. (Given to `startRouter()` itself it also leaves the
     * browser's own scroll restoration on, which the router otherwise turns off to do the restoring itself.)
     */
    scroll?: "top" | "preserve" | false;
    /**
     * Text to announce to screen readers after a page navigation — most usefully the new page's title — through a polite,
     * visually hidden `role="status"` live region the router adds to the document. Return `false` (or leave it unset) to
     * announce nothing. `title` is the document's title by then, and `pathname` the URL's path.
     */
    announce?: (info: { title: string; pathname: string }) => string | false;
}

/**
 * Merges the sources of `NavigationEffects` — the app's defaults first, then each registration, in the order given — a
 * later one winning for each setting it makes.
 */
export function mergeEffects(...sources: NavigationEffects[]): NavigationEffects {
    const merged: NavigationEffects = {};
    for (const source of sources) {
        for (const key of Object.keys(source) as Array<keyof NavigationEffects>) {
            if (source[key] !== undefined) (merged as any)[key] = source[key];
        }
    }
    return merged;
}

/** The text a blocker with no message asks the user. */
export const DEFAULT_BLOCK_MESSAGE = "You have unsaved changes. Are you sure you want to leave this page?";

/** Something that can stop the user leaving the page (see `useBlocker()`). */
export interface Blocker {
    /** Whether it's in force right now. */
    active(): boolean;
    /** What to ask (with `confirm()`) before leaving. */
    message?: string;
    /**
     * Answers in place of `confirm()`: `true` to let the navigation go ahead. A blocker that throws blocks, as being
     * wrong about losing someone's work is worse than being wrong about keeping it.
     */
    onBlock?(info: { to: string }): boolean | Promise<boolean>;
}

/** Where a page's `RouterApi.prefetch()` is told to look, and what it's told to warm. */
export interface PrefetchOptions {
    /**
     * Set to `false` to warm only the page's module (and, through it, its stylesheets), not its data: for apps whose pages
     * get their props from elsewhere, or that don't want the server to compute a page's props on a guess. Default `true`.
     */
    data?: boolean;
}

/** One place `NavigationEffects` come from, and where it stands in the order they're merged in. */
export interface EffectsSource {
    /** Sources are merged in the order of their slots, which follow the order components render in (a shell before its page). */
    slot: number;
    get(): NavigationEffects;
}

/** What the browser tells the router about the history entry it's on. */
export interface HistoryEntry {
    /** The entry's position in the session history when the router recorded it, or `null` if it has none (it predates the router). */
    index: number | null;
    /** Whether the entry was made by a shallow navigation. */
    shallow: boolean;
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
    /** Puts `page` on screen, synchronously (the new URL is already current when this is called), as a new instance. */
    render(page: RenderedPage): void;
    /** Re-renders the page that's on screen, keeping its instance, with a changed location (and props, if given). */
    update(change: PageUpdate): void;
    /** Tells the document whether a navigation is under way (which the router's container can be marked with). */
    setPending(pending: boolean): void;
    /** Records the scroll position on the current history entry, so going back can return to it. */
    saveScroll(): void;
    /** Adds (`"push"`) or replaces (`"replace"`) a history entry for `url`, marking it as made by a shallow navigation if `shallow`. */
    commitHistory(url: URL, mode: "push" | "replace", shallow?: boolean): void;
    /** What the router recorded on the history entry the browser is at. */
    historyEntry(): HistoryEntry;
    /** Moves through the session history by `delta` entries. */
    historyGo(delta: number): void;
    /** After a render: restores the entry's saved scroll position, or scrolls to `url`'s hash target / the top, and moves focus. */
    settle(url: URL, options: { restore: boolean; scroll: boolean }): void;
    /** After a page navigation: announces the new page to screen readers, if the app asked for that. */
    announce(url: URL): void;
    /** Asks the user `message`; `true` for yes. */
    confirm(message: string): boolean;
    /** Loads `url` the ordinary way. */
    hardNavigate(url: string): void;
}

/** How long a prefetched page stays usable, in milliseconds. */
export const PREFETCH_TTL_MS = 30_000;

/** How many prefetched pages are kept at once; pointing at more links than this drops the oldest. */
export const PREFETCH_MAX = 32;

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

/** Whether `href`, resolved against `base`, is an `http(s)` URL — the only kind a page is ever sent to (never `javascript:`). */
export function isHttpUrl(href: string, base: string): boolean {
    try {
        const { protocol } = new URL(href, base);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
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
 * Whether `anchor` is a link the router may deal with at all — click on it, or get its page ready for a click on it: one
 * with a destination, that isn't opening somewhere else (`target`), being downloaded, marked as leaving the site
 * (`rel="external"`), or opted out (`data-router-ignore`).
 */
export function isInterceptableAnchor(anchor: AnchorLike): boolean {
    if (anchor.getAttribute("href") === null) return false;
    const target = anchor.getAttribute("target");
    if (target && target !== "_self") return false;
    if (anchor.hasAttribute("download") || anchor.hasAttribute("data-router-ignore")) return false;
    return !(anchor.getAttribute("rel") ?? "").split(/\s+/).includes("external");
}

/**
 * Whether a click on `anchor` is an ordinary "follow this link" click the router may take over: a plain primary-button
 * click that nothing has handled yet, on a link `isInterceptableAnchor()` accepts. Anything else is the browser's to
 * handle — it's how "open in new tab" and the like keep working.
 */
export function isInterceptableClick(event: ClickLike, anchor: AnchorLike | null): boolean {
    if (!anchor || event.defaultPrevented || event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    return isInterceptableAnchor(anchor);
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

/** What the `Router` is told when it's made, besides the routes and the browser. */
export interface RouterOptions {
    /** The template of the route the page on screen is (the server's word for it; the URL's spelling can differ, as `/index` does). */
    route?: string;
    /** The app-wide `NavigationEffects`, which anything registered with `addEffects()` overrides. */
    effects?: NavigationEffects;
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
    /** The routes whose module has been warmed without their data (see `prefetch()`). */
    private readonly warmed = new Set<string>();
    /** The path and query of the page on screen (its `#fragment` is the browser's business, not a page of its own). */
    private shown: string;
    /** The URL of the page on screen, `#fragment` and all. */
    private shownUrl: URL;
    /** The template of the route the page on screen is. */
    private template: string;
    /** Whether the history entry on screen was made by a shallow navigation. */
    private shownShallow = false;
    /** Where the entry on screen is in the session history, if it's known (see `HistoryEntry`). */
    private index: number | null;
    /** Set while a `history.go()` the router made to undo a refused back/forward is under way, so its `popstate` is ignored. */
    private restoring = false;
    /** Whether a blocker is being asked right now, so that a second navigation isn't started on top of it. */
    private confirming = false;
    private readonly blockers = new Set<Blocker>();
    /** Whether a navigation is in flight, and who wants to know when that changes (see `subscribePending()`). */
    private pending = false;
    private readonly pendingListeners = new Set<() => void>();
    private readonly effectSources: EffectsSource[] = [];

    constructor(
        routes: ClientRoute[],
        private readonly prefix: string,
        private readonly platform: RouterPlatform,
        private readonly now: () => number = Date.now,
        private readonly options: RouterOptions = {},
    ) {
        this.routes = sortRoutes(routes);
        this.shownUrl = platform.location();
        this.shown = Router.key(this.shownUrl);
        this.template = options.route ?? this.match(this.shownUrl)?.route.template ?? "";
        this.index = platform.historyEntry().index;
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

    /** The URL the browser is at. */
    currentUrl(): URL {
        return this.platform.location();
    }

    /** Whether a navigation is in flight: its page and data being loaded, and nothing yet on screen. */
    isPending(): boolean {
        return this.pending;
    }

    /** Calls `listener` whenever `isPending()` changes; returns the function that stops it. (What `useSyncExternalStore()` takes.) */
    subscribePending(listener: () => void): () => void {
        this.pendingListeners.add(listener);
        return () => void this.pendingListeners.delete(listener);
    }

    private setPending(pending: boolean): void {
        if (this.pending === pending) return;
        this.pending = pending;
        this.platform.setPending(pending);
        for (const listener of [...this.pendingListeners]) listener();
    }

    /**
     * Starts fetching the page at `href` (its module and its data) so that navigating to it shortly after is quick.
     * Quietly does nothing for anything `navigate()` wouldn't handle, and for a page fetched within the last
     * `PREFETCH_TTL_MS`. With `{ data: false }` only the page's module is fetched (and once is enough).
     */
    prefetch(href: string, options: PrefetchOptions = {}): void {
        const target = resolveTarget(href, this.platform.location().href);
        const match = target && this.match(target);
        if (!target || !match) return;
        // A page whose route starts with a `:param` answers for any first segment of the URL — `/logout` as much as
        // `/pets`, and something else on the server may be what serves that. Warming a page must never run one of those.
        if (match.route.template.startsWith("/:")) return;
        if (options.data === false) {
            this.warm(match.route);
            return;
        }
        const key = Router.key(target);
        const existing = this.prefetched.get(key);
        if (existing && this.now() - existing.at < PREFETCH_TTL_MS) return;
        this.start(target, match.route, new AbortController().signal, key);
    }

    /** Loads a route's module once, and lets it be tried again if that failed. */
    private warm(route: ClientRoute): void {
        if (this.warmed.has(route.template)) return;
        this.warmed.add(route.template);
        route.load().catch(() => this.warmed.delete(route.template));
    }

    private start(url: URL, route: ClientRoute, signal: AbortSignal, key: string): Prefetched {
        // Expired entries are otherwise only dropped when the same page is asked for again, which most never are.
        for (const [oldKey, old] of this.prefetched) {
            if (this.now() - old.at >= PREFETCH_TTL_MS || this.prefetched.size >= PREFETCH_MAX) this.prefetched.delete(oldKey);
            else break;
        }
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
     * Registers something that stops the user leaving the page while it's `active()`: a client navigation to another page
     * (a link, `navigate()`, back or forward) asks it first, and a real page load is met with the browser's own prompt
     * (see `shouldBlockUnload()`). Returns the function that removes it.
     */
    block(blocker: Blocker): () => void {
        this.blockers.add(blocker);
        return () => void this.blockers.delete(blocker);
    }

    /** Whether any blocker is in force, which a real page load (the tab closing, an external link) must give the browser's prompt for. */
    shouldBlockUnload(): boolean {
        return [...this.blockers].some((blocker) => blocker.active());
    }

    /** Registers a source of `NavigationEffects`, which overrides the ones registered before it (by slot) and the app's defaults. Returns the function that removes it. */
    addEffects(source: EffectsSource): () => void {
        this.effectSources.push(source);
        this.effectSources.sort((a, b) => a.slot - b.slot);
        return () => {
            const at = this.effectSources.indexOf(source);
            if (at >= 0) this.effectSources.splice(at, 1);
        };
    }

    /** The effects in force now: the app's defaults, overridden by whatever is registered. */
    effects(): NavigationEffects {
        return mergeEffects(this.options.effects ?? {}, ...this.effectSources.map((source) => source.get()));
    }

    /** Asks each blocker that's in force, in turn, whether `target` may be left for; stops at the first no. */
    private async confirmLeave(target: URL): Promise<boolean> {
        if (this.confirming) return false;
        this.confirming = true;
        try {
            for (const blocker of [...this.blockers]) {
                if (!blocker.active()) continue;
                let allowed: boolean;
                if (blocker.onBlock) {
                    try {
                        allowed = await blocker.onBlock({ to: target.href });
                    } catch {
                        allowed = false;
                    }
                } else {
                    allowed = this.platform.confirm(blocker.message ?? DEFAULT_BLOCK_MESSAGE);
                }
                if (!allowed) return false;
            }
            return true;
        } finally {
            this.confirming = false;
        }
    }

    /** Adds or replaces the history entry for `url`, and notes where that leaves the router in the session history. */
    private commit(url: URL, mode: "push" | "replace", shallow: boolean = false): void {
        if (shallow) this.platform.commitHistory(url, mode, true);
        else this.platform.commitHistory(url, mode);
        this.index = this.platform.historyEntry().index;
    }

    /** Takes over from a navigation still under way (aborting its request), and returns what tells whether it's been overtaken in turn. */
    private begin(): { controller: AbortController; superseded: () => boolean } {
        const token = ++this.navigation;
        this.controller?.abort();
        const controller = (this.controller = new AbortController());
        return { controller, superseded: () => token !== this.navigation };
    }

    /**
     * Navigates to `to`. Resolves `true` when that was done without a full page load (or was overtaken by a newer
     * navigation, which is now what's being done instead) and `false` when it was left to the browser to load the
     * page the ordinary way, or a blocker (`useBlocker()`) refused it.
     */
    async navigate(to: string, options: NavigateOptions = {}): Promise<boolean> {
        this.restoring = false;
        const current = this.platform.location();
        const target = resolveTarget(to, current.href);
        if (!target) return this.fallBack(to);
        const mode = options.replace ? "replace" : "push";
        // Another `#fragment` of the page showing isn't a navigation: it's a history entry and a scroll.
        if (isHashChange(target, current)) {
            this.commit(target, mode);
            this.platform.update({ url: target });
            this.platform.settle(target, { restore: false, scroll: options.scroll !== false });
            this.shownUrl = target;
            return true;
        }
        const match = this.match(target);
        if (!match) return this.fallBack(target.href);

        const entry = target.href === current.href ? "replace" : mode;
        if (match.route.template === this.template && (options.shallow === true || options.remount === false)) {
            return this.goShallow(target, match, entry, options.refetch === true, true);
        }
        if (this.shouldBlockUnload() && !(await this.confirmLeave(target))) return false;
        return this.go(target, match, entry, options.scroll !== false, false);
    }

    /** Shows the page for the document's URL after the browser moved through history (back/forward). */
    async popstate(): Promise<boolean> {
        if (this.restoring) {
            this.restoring = false;
            // The undo should have brought the browser back to the entry the page is of. If the session history isn't as
            // the router recorded it (a browser drops the oldest entries of a long one, moving the rest), it didn't: the
            // page's URL is put back as an entry instead, so the address bar and the page agree.
            if (Router.key(this.platform.location()) !== this.shown) this.commit(this.shownUrl, "push", this.shownShallow);
            return true;
        }
        const target = this.platform.location();
        const entry = this.platform.historyEntry();
        // Only the `#fragment` changed (the browser fires this for following one too): the page on screen is the page, and
        // the browser has moved to the fragment itself — fetching and rendering it all over would only lose its state.
        if (Router.key(target) === this.shown) {
            this.platform.update({ url: target });
            this.shownUrl = target;
            this.index = entry.index;
            this.shownShallow = entry.shallow;
            return true;
        }
        const match = this.match(target);
        if (!match) return this.fallBack(target.href);
        // Going back over a shallow navigation, or forward over one, is shallow as well: the page instance is the one that's there.
        if (match.route.template === this.template && (entry.shallow || this.shownShallow)) {
            this.index = entry.index;
            return this.goShallow(target, match, null, false, entry.shallow);
        }
        if (this.shouldBlockUnload() && !(await this.confirmLeave(target))) {
            this.undoPopstate(entry);
            return false;
        }
        this.index = entry.index;
        return this.go(target, match, null, true, true);
    }

    /**
     * Puts the browser back on the entry it was moved off by a back/forward the user then refused: by going through
     * history to it when both entries' positions are known, and otherwise by adding an entry for the page still on screen
     * (which costs the entries ahead of it, but leaves the address bar and the page agreeing).
     */
    private undoPopstate(arrived: HistoryEntry): void {
        if (this.index !== null && arrived.index !== null && this.index !== arrived.index) {
            this.restoring = true;
            this.platform.historyGo(this.index - arrived.index);
        } else {
            this.commit(this.shownUrl, "push", this.shownShallow);
        }
    }

    private fallBack(url: string): false {
        // Anything but an `http(s)` URL (a `javascript:` one an app passed on from a query string, say) is not somewhere to go.
        if (isHttpUrl(url, this.platform.location().href)) this.platform.hardNavigate(url);
        return false;
    }

    /**
     * Changes the location of the page on screen without replacing it: `update()`s it (with new props, if `refetch`
     * fetched them). `mode` is how the history entry is made, or `null` when the browser already did it (back/forward);
     * `entryShallow` is whether that entry counts as made by a shallow navigation.
     */
    private async goShallow(
        target: URL,
        match: RouteMatch,
        mode: "push" | "replace" | null,
        refetch: boolean,
        entryShallow: boolean,
    ): Promise<boolean> {
        const { controller, superseded } = this.begin();
        let fetched: { props: any } | null = null;
        if (refetch) {
            this.setPending(true);
            try {
                const payload = await this.platform.fetchPayload(target, controller.signal);
                if (superseded()) return true;
                if (!payload || payload.route !== match.route.template) return this.fallBack(target.href);
                if (payload.title !== undefined) this.platform.setTitle(payload.title);
                fetched = { props: payload.props };
            } catch {
                return superseded() ? true : this.fallBack(target.href);
            } finally {
                if (!superseded()) this.setPending(false);
            }
        } else {
            // A navigation still under way has just been overtaken by this one, which needs nothing from the server.
            this.setPending(false);
        }
        if (mode) this.commit(target, mode, true);
        this.platform.update({ url: target, params: match.params, ...(fetched ? { props: fetched.props } : {}) });
        this.shown = Router.key(target);
        this.shownUrl = target;
        this.shownShallow = entryShallow;
        return true;
    }

    private async go(
        target: URL,
        match: RouteMatch,
        mode: "push" | "replace" | null,
        scroll: boolean,
        restore: boolean,
    ): Promise<boolean> {
        const { controller, superseded } = this.begin();
        this.setPending(true);

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
            // Before the page renders, so a title the page sets for itself (React hoists a `<title>` it renders) wins.
            if (payload.title !== undefined) this.platform.setTitle(payload.title);
            if (mode) this.commit(target, mode);
            // Before the page renders, so that it's the one render that puts the page and the end of the wait on screen.
            this.setPending(false);
            this.platform.render({
                component: module.default,
                props: payload.props,
                url: target,
                params: match.params,
                route: match.route.template,
            });
            this.platform.settle(target, { restore, scroll });
            this.platform.announce(target);
            this.shown = key;
            this.shownUrl = target;
            this.template = match.route.template;
            this.shownShallow = false;
            this.platform.pruneStyles(payload.css);
            return true;
        } catch {
            // Overtaken while it failed (its request was aborted, most likely): not this navigation's problem any more.
            return superseded() ? true : this.fallBack(target.href);
        } finally {
            this.prefetched.delete(Router.key(target));
            if (!superseded()) this.setPending(false);
        }
    }
}

/** The name of an app's router entry among the Vite build's inputs, under the app's directory (`apps/www/__router`). */
export const ROUTER_ENTRY_NAME = "__router";
