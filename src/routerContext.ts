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
    useContext,
} from "react";
import { isInterceptableClick, type NavigateOptions } from "./routerCore.js";

/*
 * The React side of the router: what a page can ask it (where am I, take me there) and the `<Link>` component. Used on
 * the server as well as in the browser — the server renders a page inside the same `RouterProvider` the browser
 * hydrates it in, so anything that reads the location (highlighting the current link in a nav) renders identically on
 * both and hydration never disagrees with the HTML. The server has no router to navigate with, so there it's given none
 * (`api: null`) and a `Link` is just an ordinary link.
 */

/** Where the page is, as far as the router is concerned. */
export interface RouterLocation {
    /** The URL's path, including any mount prefix. */
    pathname: string;
    /** The URL's query string, including the leading `?` (or empty). */
    search: string;
    /** The values the route's `:params` captured. */
    params: Record<string, string>;
    /** The route's template, e.g. `/users/:id`. */
    route: string;
}

/** What a page can ask the router to do. */
export interface RouterApi {
    /** Navigates to `to`; resolves `true` if that was done without a full page load, `false` if the browser was left to. */
    navigate(to: string, options?: NavigateOptions): Promise<boolean>;
    /** Starts fetching the page at `href` so navigating to it soon after is quick. */
    prefetch(href: string): void;
    /** Whether navigating to `href` would be done without a full page load. */
    canHandle(href: string): boolean;
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

/** What `useRouter()` reports outside any router (a page rendered with no router at all): nowhere in particular. */
const NO_LOCATION: RouterLocation = { pathname: "", search: "", params: {}, route: "" };

/** ...and what it can do there: nothing but leave the page the ordinary way. */
const NO_ROUTER: RouterApi = {
    navigate: async (to) => {
        if (typeof window !== "undefined") window.location.assign(to);
        return false;
    },
    prefetch: () => undefined,
    canHandle: () => false,
};

export interface RouterProviderProps {
    location: RouterLocation;
    /** The router to navigate with. `null` (the server's case) means there is none: links are just links. */
    api?: RouterApi | null;
}

/** Makes the location, and the router if there is one, available to everything under it. Renders no markup of its own. */
export function RouterProvider({ location, api = null, children }: PropsWithChildren<RouterProviderProps>): ReactElement {
    return createElement(RouterContext.Provider, { value: { location, api } }, children);
}

/** Where the page is, and the ways to go somewhere else. Outside a `RouterProvider`, "nowhere", and a full page load. */
export function useRouter(): RouterLocation & RouterApi {
    const context = useContext(RouterContext);
    return { ...(context?.location ?? NO_LOCATION), ...(context?.api ?? NO_ROUTER) };
}

/** The URL's path, including any mount prefix. */
export function usePathname(): string {
    return useRouter().pathname;
}

/** The values the route's `:params` captured. */
export function useParams(): Record<string, string> {
    return useRouter().params;
}

/** What a `Link`'s handlers need: the router (if there is one), the destination, and the link's own options. */
export interface LinkBehavior {
    api: RouterApi | null;
    href: string;
    replace?: boolean;
    scroll?: boolean;
    prefetch: boolean;
}

/**
 * The handlers behind a `<Link>`, as plain functions so they can be reasoned about (and tested) without rendering
 * anything: a click the router can take over is taken over (and a link it can't is left to the browser), and pointing
 * at or focusing a link warms the page it goes to.
 */
export function linkHandlers(
    { api, href, replace, scroll, prefetch }: LinkBehavior,
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
            void api.navigate(href, { replace, scroll });
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
    /** Set to `false` to not fetch the page ahead of time when the link is pointed at or focused. Default `true`. */
    prefetch?: boolean;
}

/**
 * A link. Renders as an ordinary `<a href>` — on the server, and for a crawler, and until the page has hydrated — and
 * in the browser, a plain click on one that goes to another of the app's pages navigates there without a full page
 * load (modified clicks, `target`, `download` and `rel="external"` links are left to the browser, as ever). Any
 * ordinary `<a>` gets the same treatment automatically; a `Link` adds warming the page up ahead of the click, and
 * `replace`/`scroll` control.
 */
export function Link({ href, replace, scroll, prefetch = true, onClick, onMouseEnter, onFocus, ...rest }: LinkProps): ReactElement {
    const api = useContext(RouterContext)?.api ?? null;
    return createElement("a", {
        ...rest,
        href,
        ...linkHandlers({ api, href, replace, scroll, prefetch }, { onClick, onMouseEnter, onFocus }),
    });
}
