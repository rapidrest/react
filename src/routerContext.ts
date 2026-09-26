///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    type AnchorHTMLAttributes,
    type Context,
    createContext,
    createElement,
    type FocusEvent,
    type MouseEvent,
    type PropsWithChildren,
    type ReactElement,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore,
} from "react";
import { matchPathPattern, type PathMatch } from "./routeMatch.js";
import {
    type Blocker,
    type EffectsSource,
    isHttpUrl,
    isInterceptableClick,
    type NavigateOptions,
    type NavigationEffects,
    type PrefetchOptions,
} from "./routerCore.js";

/*
 * The React side of the router: what a page can ask it (where am I, take me there, is this link where I am, am I about to
 * lose work) and the `<Link>` component. Used on the server as well as in the browser — the server renders a page inside
 * the same `RouterProvider` the browser hydrates it in, so anything that reads the location (highlighting the current
 * link in a nav) renders identically on both and hydration never disagrees with the HTML. The server has no router to
 * navigate with, so there it's given none (`api: null`) and a `Link` is just an ordinary link.
 */

/** Where the page is, as far as the router is concerned. */
export interface RouterLocation {
    /** The URL's path, including any mount prefix. */
    pathname: string;
    /** The URL's query string, including the leading `?` (or empty). */
    search: string;
    /** The URL's fragment, including the leading `#` (or empty; the server never has one, so it renders as empty until the browser has hydrated). */
    hash: string;
    /** The values the route's `:params` captured. */
    params: Record<string, string>;
    /** The route's template, e.g. `/users/:id`. */
    route: string;
}

/** What a page can ask the router to do. */
export interface RouterApi {
    /** Navigates to `to`; resolves `true` if that was done without a full page load, `false` if the browser was left to (or a blocker refused). */
    navigate(to: string, options?: NavigateOptions): Promise<boolean>;
    /** Starts fetching the page at `href` so navigating to it soon after is quick. */
    prefetch(href: string, options?: PrefetchOptions): void;
    /** Whether navigating to `href` would be done without a full page load. */
    canHandle(href: string): boolean;
    /** Registers a blocker (see `useBlocker()`); returns the function that removes it. */
    block(blocker: Blocker): () => void;
    /** Registers a source of navigation effects (see `useNavigationEffects()`); returns the function that removes it. */
    addEffects(source: EffectsSource): () => void;
    /** The URL the browser is at right now. */
    currentUrl(): URL;
    /** Whether a navigation is in flight. */
    isPending(): boolean;
    /** Calls `listener` when `isPending()` changes; returns the function that stops it. */
    subscribePending(listener: () => void): () => void;
}

interface RouterContextValue {
    location: RouterLocation;
    api: RouterApi | null;
}

/**
 * The context is shared through a global symbol rather than created here, because this module can be loaded twice: the
 * server renders a page inside `ReactRoute`'s `RouterProvider` (from this package's server build), while the page's own
 * `Link` and hooks import this module from `@rapidrest/react/client` — a second compiled copy, with a second context
 * object that the provider would never reach. Sharing one keeps what the server renders identical to what the browser
 * hydrates, whichever copy each part came from.
 */
const CONTEXT_KEY = Symbol.for("@rapidrest/react/RouterContext");
const RouterContext: Context<RouterContextValue | null> = ((globalThis as any)[CONTEXT_KEY] ??= createContext<RouterContextValue | null>(null));

/** The same, for the order in which components that register navigation effects rendered (see `useNavigationEffects()`). */
const SLOT_KEY = Symbol.for("@rapidrest/react/EffectsSlot");

/** What `useRouter()` reports outside any router (a page rendered with no router at all): nowhere in particular. */
const NO_LOCATION: RouterLocation = { pathname: "", search: "", hash: "", params: {}, route: "" };

/** ...and what it can do there: nothing but leave the page the ordinary way. */
const NO_ROUTER: RouterApi = {
    navigate: async (to) => {
        if (typeof window !== "undefined" && isHttpUrl(to, window.location.href)) window.location.assign(to);
        return false;
    },
    prefetch: () => undefined,
    canHandle: () => false,
    block: () => () => undefined,
    addEffects: () => () => undefined,
    currentUrl: () => new URL(typeof window === "undefined" ? "http://localhost/" : window.location.href),
    isPending: () => false,
    subscribePending: () => () => undefined,
};

/**
 * Renders its children as they are, and tells `onMounted` once they have been mounted in the browser — for hydration, once it
 * has committed. (An update sent to a root before that has been through hydration would throw it away and render the
 * page anew on the client.) It is always there, server and browser, so the tree is the same shape in both.
 */
function AfterMount({ onMounted, children }: PropsWithChildren<{ onMounted?: () => void }>): ReactNode {
    useEffect(() => onMounted?.(), []);
    return children;
}

export interface RouterProviderProps {
    /** Where the page is. `hash` may be left out, meaning none (which is what the server always has). */
    location: Omit<RouterLocation, "hash"> & { hash?: string };
    /** The router to navigate with. `null` (the server's case) means there is none: links are just links. */
    api?: RouterApi | null;
    /** Called once, in the browser, after what's under the provider has mounted (hydrated). */
    onMounted?: () => void;
}

/** Makes the location, and the router if there is one, available to everything under it. Renders no markup of its own. */
export function RouterProvider({ location, api = null, onMounted, children }: PropsWithChildren<RouterProviderProps>): ReactElement {
    return createElement(RouterContext.Provider, { value: { location: { ...location, hash: location.hash ?? "" }, api } }, createElement(AfterMount, { onMounted }, children));
}

/** What `useRouter()` gives: where the page is, whether a navigation is under way, and the ways to go somewhere else. */
export type UseRouter = RouterLocation & {
    /** `true` while a navigation is in flight (its page and data being loaded), `false` otherwise, and always on the server. */
    pending: boolean;
    navigate: RouterApi["navigate"];
    prefetch: RouterApi["prefetch"];
    canHandle: RouterApi["canHandle"];
};

/** Where the page is, and the ways to go somewhere else. Outside a `RouterProvider`, "nowhere", and a full page load. */
export function useRouter(): UseRouter {
    const context = useContext(RouterContext);
    const location = context?.location ?? NO_LOCATION;
    const api = context?.api ?? NO_ROUTER;
    // Not part of the location (which is replaced when the page is): a navigation starting or ending re-renders what asks, not the whole tree.
    const subscribe = useCallback((listener: () => void) => api.subscribePending(listener), [api]);
    const pending = useSyncExternalStore(subscribe, () => api.isPending(), () => false);
    // The router's methods are called through `api` rather than copied off it: they live on its prototype, which
    // spreading an instance (`{ ...api }`) silently leaves behind.
    return useMemo(
        () => ({
            ...location,
            pending,
            navigate: (to: string, options?: NavigateOptions) => api.navigate(to, options),
            prefetch: (...args: Parameters<RouterApi["prefetch"]>) => api.prefetch(...args),
            canHandle: (href: string) => api.canHandle(href),
        }),
        [location, api, pending],
    );
}

/** The URL's path, including any mount prefix. */
export function usePathname(): string {
    return useRouter().pathname;
}

/** The values the route's `:params` captured. */
export function useParams(): Record<string, string> {
    return useRouter().params;
}

/** The URL's path, query string and fragment, as `{ pathname, search, hash }` (`search` and `hash` with their `?` and `#`, or empty). */
export function useLocation(): Pick<RouterLocation, "pathname" | "search" | "hash"> {
    const { pathname, search, hash } = (useContext(RouterContext)?.location ?? NO_LOCATION);
    return useMemo(() => ({ pathname, search, hash }), [pathname, search, hash]);
}

/** Everything `new URLSearchParams()` takes, and a plain object whose values may be lists (or `undefined`, which leaves the key out). */
export type SearchParamsInit =
    | string
    | URLSearchParams
    | Array<[string, string]>
    | Record<string, string | string[] | undefined>;

/** Builds a `URLSearchParams` from any `SearchParamsInit`. */
export function createSearchParams(init: SearchParamsInit): URLSearchParams {
    if (typeof init === "string" || init instanceof URLSearchParams || Array.isArray(init)) return new URLSearchParams(init);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(init)) {
        if (value === undefined) continue;
        for (const each of Array.isArray(value) ? value : [value]) params.append(key, each);
    }
    return params;
}

/** What `setSearchParams()` accepts as options: how the history entry is made and whether the page is kept. */
export interface SetSearchParamsOptions {
    /** Replace the current history entry rather than adding one. */
    replace?: boolean;
    /** Default `true`: the page instance stays, and only what reads the location re-renders. `false`: an ordinary navigation, which fetches the page's props again and remounts it. */
    shallow?: boolean;
    /** With `shallow`, fetch the page's props for the new query from the server. */
    refetch?: boolean;
    /** Set to `false` to leave the scroll position alone (only matters when not `shallow`). */
    scroll?: boolean;
}

/** Changes the query string: a new one, or a function of the current one that returns it. */
export type SetSearchParams = (
    next: SearchParamsInit | ((previous: URLSearchParams) => SearchParamsInit),
    options?: SetSearchParamsOptions,
) => void;

/**
 * The current URL's query as a `URLSearchParams` (read-only in spirit: changing the object changes nothing), and a
 * function that goes to the same page with another query. It keeps the path and the `#fragment`, and — unlike an
 * ordinary navigation — by default keeps the page instance too (`shallow`), so that a filter, a folder or a sort order
 * can change without the page losing its state. Renders the same on the server, where the query is the request's.
 */
export function useSearchParams(): [URLSearchParams, SetSearchParams] {
    const context = useContext(RouterContext);
    const search = (context?.location ?? NO_LOCATION).search;
    const api = context?.api ?? NO_ROUTER;
    const params = useMemo(() => new URLSearchParams(search), [search]);
    const setSearchParams = useCallback<SetSearchParams>(
        (next, options: SetSearchParamsOptions = {}) => {
            // From the browser's URL, not the last render's: several updates in one handler each build on the one before.
            const url = api.currentUrl();
            const value = typeof next === "function" ? next(new URLSearchParams(url.search)) : next;
            const query = createSearchParams(value).toString();
            void api.navigate(url.pathname + (query ? "?" + query : "") + url.hash, {
                replace: options.replace,
                scroll: options.scroll,
                refetch: options.refetch,
                shallow: options.shallow ?? true,
            });
        },
        [api],
    );
    return [params, setSearchParams];
}

/**
 * Matches the current path against `pattern` — literal segments, `:name` segments, and a trailing `*` (`/pets/:id`,
 * `/settings/*`) — and returns what it captured, or `null`. The whole path has to match unless `end` is `false`. The
 * path is the URL's, mount prefix included, like every other path a page reads or links to.
 */
export function useMatch(pattern: string, options: { end?: boolean } = {}): PathMatch | null {
    const { pathname } = useRouter();
    const end = options.end ?? true;
    return useMemo(() => matchPathPattern(pattern, pathname, end), [pattern, pathname, end]);
}

/** What `useBlocker()` takes in place of a message: more control over what is asked. */
export interface BlockerOptions {
    /** What to ask with `confirm()`. */
    message?: string;
    /** Answers in place of `confirm()` — a dialog of the app's own, say. `true` lets the navigation go ahead. */
    onBlock?: (info: { to: string }) => boolean | Promise<boolean>;
}

/**
 * While `when` is (or returns) `true`, leaving the page asks first: a client navigation (a link, `navigate()`, back or
 * forward) shows `window.confirm(message)`, or calls `onBlock` for an answer, and is dropped if the user says no; and
 * closing the tab, reloading or following a link that has to load a page brings up the browser's own "leave site?"
 * prompt (which can't be given text or a dialog of its own). A refused back/forward puts the browser back where it was.
 *
 * Only a change of page is asked about: a shallow navigation (`shallow`, `setSearchParams()`) and a `#fragment` leave
 * the page, and the work in it, where it is. Does nothing outside the router (on the server, in a page it doesn't run).
 */
export function useBlocker(when: boolean | (() => boolean), message?: string | BlockerOptions): void {
    const api = useContext(RouterContext)?.api ?? NO_ROUTER;
    // What was rendered last is what's asked: the effect below registers once, not on every render.
    const latest = useRef({ when, message });
    latest.current = { when, message };
    useEffect(() => {
        const options = (): BlockerOptions => {
            const current = latest.current.message;
            return typeof current === "string" ? { message: current } : (current ?? {});
        };
        return api.block({
            active: () => {
                const current = latest.current.when;
                return typeof current === "function" ? current() : current;
            },
            get message() {
                return options().message;
            },
            get onBlock() {
                return options().onBlock;
            },
        });
    }, [api]);
}

/**
 * Sets what happens after a page navigation — where focus goes, how the page scrolls, what a screen reader is told (see
 * `NavigationEffects`) — for as long as the component is mounted, over the defaults the app gave `startRouter()`. Call
 * it in the app's shell for settings that hold for the whole app, or in a page for that page alone; where both set the
 * same thing the one that rendered later, which is the page, wins. Does nothing on the server.
 */
export function useNavigationEffects(effects: NavigationEffects): void {
    const api = useContext(RouterContext)?.api ?? NO_ROUTER;
    const latest = useRef(effects);
    latest.current = effects;
    // The place in line is taken when the component first renders (a parent renders before its children, and effects run
    // the other way round), so a shell is always earlier than the page in it, however the effects happen to be ordered.
    const slot = useRef(0);
    if (slot.current === 0) {
        const next = (((globalThis as any)[SLOT_KEY] as number | undefined) ?? 0) + 1;
        (globalThis as any)[SLOT_KEY] = next;
        slot.current = next;
    }
    useEffect(() => api.addEffects({ slot: slot.current, get: () => latest.current }), [api]);
}

/** What a `Link`'s handlers need: the router (if there is one), the destination, and the link's own options. */
export interface LinkBehavior {
    api: RouterApi | null;
    href: string;
    replace?: boolean;
    scroll?: boolean;
    shallow?: boolean;
    refetch?: boolean;
    prefetch: boolean;
}

/**
 * The handlers behind a `<Link>`, as plain functions so they can be reasoned about (and tested) without rendering
 * anything: a click the router can take over is taken over (and a link it can't is left to the browser), and pointing
 * at or focusing a link warms the page it goes to.
 */
export function linkHandlers(
    { api, href, replace, scroll, shallow, refetch, prefetch }: LinkBehavior,
    user: {
        onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
        onMouseEnter?: (event: MouseEvent<HTMLAnchorElement>) => void;
        onFocus?: (event: FocusEvent<HTMLAnchorElement>) => void;
    },
) {
    const warm = () => {
        if (api && prefetch) api.prefetch(href);
    };
    return {
        onClick(event: MouseEvent<HTMLAnchorElement>) {
            user.onClick?.(event);
            if (!api || !isInterceptableClick(event, event.currentTarget) || !api.canHandle(href)) return;
            event.preventDefault();
            void api.navigate(href, { replace, scroll, shallow, refetch });
        },
        onMouseEnter(event: MouseEvent<HTMLAnchorElement>) {
            user.onMouseEnter?.(event);
            warm();
        },
        onFocus(event: FocusEvent<HTMLAnchorElement>) {
            user.onFocus?.(event);
            warm();
        },
    };
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
    /** Where the link goes. */
    href: string;
    /** Replace the current history entry rather than adding one. */
    replace?: boolean;
    /** Set to `false` to leave the scroll position alone after navigating. */
    scroll?: boolean;
    /**
     * Keep the page instance, its state and its scroll position, when the link goes to another URL of the page that's
     * showing (another query, another `:param`, another `#fragment`) — only the location changes, and what reads it
     * (`useRouter()`, `useSearchParams()`) re-renders. Default `false`: the page is fetched again and remounted, as it
     * always was. Has no effect on a link to another page.
     */
    shallow?: boolean;
    /** With `shallow`, fetch the page's props for the link's URL from the server and hand them to the page. */
    refetch?: boolean;
    /** Set to `false` to not fetch the page ahead of time when the link is pointed at or focused. Default `true`. */
    prefetch?: boolean;
}

/**
 * A link. Renders as an ordinary `<a href>` — on the server, and for a crawler, and until the page has hydrated — and
 * in the browser, a plain click on one that goes to another of the app's pages navigates there without a full page
 * load (modified clicks, `target`, `download` and `rel="external"` links are left to the browser, as ever). Any
 * ordinary `<a>` gets the same treatment automatically; a `Link` adds warming the page up ahead of the click, and
 * `replace`/`scroll`/`shallow` control.
 */
export function Link({
    href,
    replace,
    scroll,
    shallow,
    refetch,
    prefetch = true,
    onClick,
    onMouseEnter,
    onFocus,
    ...rest
}: LinkProps): ReactElement {
    const api = useContext(RouterContext)?.api ?? null;
    return createElement("a", {
        ...rest,
        // Tells the router's handling of plain links, which also warms pages up, to leave this one be.
        ...(prefetch ? {} : { "data-router-prefetch": "false" }),
        href,
        ...linkHandlers({ api, href, replace, scroll, shallow, refetch, prefetch }, { onClick, onMouseEnter, onFocus }),
    });
}

/** What a `NavLink` tells its `className` function. */
export interface NavLinkState {
    /** Whether the link goes to where the page is now. */
    active: boolean;
}

/** `decodeURIComponent()`, but a malformed escape is left as written instead of throwing. */
function decodeLoosely(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * Whether a link to `href` goes to where the page is (`location`): its path is the current path, or — unless `end` — one
 * of the segments above it (`/settings` is active on `/settings/profile`, but `/settingsx` isn't); the mount root `/` is
 * only ever active on itself. With `matchQuery` every query parameter the link has must be in the current query too
 * (`?folder=inbox`), otherwise the query is ignored. Only a link to a path is ever active, never one to another site.
 * The `#fragment` is always ignored.
 */
export function isLinkActive(
    href: string,
    location: Pick<RouterLocation, "pathname" | "search">,
    options: { end?: boolean; matchQuery?: boolean } = {},
): boolean {
    const base = new URL(location.pathname + location.search, "http://router.invalid");
    let target: URL;
    try {
        target = new URL(href, base);
    } catch {
        return false;
    }
    if (target.origin !== base.origin) return false;
    const segments = (path: string) => path.split("/").filter(Boolean).map(decodeLoosely);
    const linked = segments(target.pathname);
    const current = segments(base.pathname);
    const exact = options.end === true || linked.length === 0;
    if (exact ? linked.length !== current.length : linked.length > current.length) return false;
    if (!linked.every((segment, i) => segment === current[i])) return false;
    if (!options.matchQuery) return true;
    return [...target.searchParams].every(([key, value]) => base.searchParams.getAll(key).includes(value));
}

export interface NavLinkProps extends Omit<LinkProps, "className"> {
    /** Only active on exactly the link's path, not on the pages below it. */
    end?: boolean;
    /** Also require the link's query parameters to be in the current query. */
    matchQuery?: boolean;
    /** Added to the class names while the link is active. */
    activeClassName?: string;
    /** The class name, or a function of whether the link is active that returns it. */
    className?: string | ((state: NavLinkState) => string | undefined);
}

/**
 * A `Link` that knows whether it goes to where the page is: while it does it has `aria-current="page"` (which is what
 * assistive technology reads as "current page", and a stylesheet can select on), and `activeClassName` (or whatever a
 * `className` function returns for the active state). Active is worked out from the router's location, so the server
 * renders it — and the browser hydrates it — the same, and it follows navigation.
 */
export function NavLink({ end, matchQuery, activeClassName, className, ...rest }: NavLinkProps): ReactElement {
    const location = useContext(RouterContext)?.location ?? NO_LOCATION;
    const active = isLinkActive(rest.href, location, { end, matchQuery });
    let resolved: string | undefined;
    if (typeof className === "function") resolved = className({ active });
    else resolved = active && activeClassName ? [className, activeClassName].filter(Boolean).join(" ") : className;
    return createElement(Link, {
        ...rest,
        className: resolved,
        "aria-current": active ? (rest["aria-current"] ?? "page") : rest["aria-current"],
    });
}
