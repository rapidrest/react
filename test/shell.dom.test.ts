// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { act, createElement as h, useEffect, useState } from "react";
import { renderToString } from "react-dom/server";
import { vi } from "vitest";
import { ANNOUNCE_DELAY_MS, RECOVERY_KEY, startRouter, type StartRouterOptions } from "../src/router.js";
import {
    type BlockerOptions,
    Link,
    NavLink,
    RouterProvider,
    useBlocker,
    useNavigationEffects,
    useRouter,
    useSearchParams,
} from "../src/routerContext.js";
import { NAVIGATION_HEADER, ROUTER_CONFIG_ID, type NavigationEffects, type Router } from "../src/routerCore.js";

/*
 * The client router in a real DOM (jsdom) with the real React reconciler: a shell server-rendered around a page, hydrated
 * with it as one root, and kept mounted while pages are swapped in inside it. What can't be told from a fake platform —
 * that an instance survives, that a page remounts, that hydration agrees with the markup — is told here.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// --- What the app is made of -----------------------------------------------------------------------------------------

/** What happened to the components, across renders. */
const log = { shellMounts: 0, shellUnmounts: 0, mounts: {} as Record<string, number> };
/** What a test can change about how the app behaves. */
const behavior = {
    shellEffects: {} as NavigationEffects,
    pageEffects: {} as NavigationEffects,
    blocked: false,
    blockerOptions: undefined as string | BlockerOptions | undefined,
    /** A shell that throws while it renders in the browser (the server never sees this). */
    shellThrows: false,
};
/** What the page on screen last rendered with, for a test to call into. */
const latest = { setParams: undefined as any, params: undefined as URLSearchParams | undefined, router: undefined as any };

function countMount(name: string) {
    useEffect(() => {
        log.mounts[name] = (log.mounts[name] ?? 0) + 1;
    }, []);
}

function Shell({ children, label }: { children?: any; label?: string }) {
    const [count, setCount] = useState(0);
    const router = useRouter();
    useNavigationEffects(behavior.shellEffects);
    useEffect(() => {
        log.shellMounts++;
        return () => {
            log.shellUnmounts++;
        };
    }, []);
    if (behavior.shellThrows && label === "/shell-boom") throw new Error("shell broke");
    return h(
        "div",
        { id: "shell", "data-path": router.pathname, "data-pending": String(router.pending), "data-label": label },
        h("button", { id: "count", onClick: () => setCount((c) => c + 1) }, `count ${count}`),
        h("nav", null, h(NavLink, { href: "/", id: "link-a" }, "A"), h(NavLink, { href: "/b", id: "link-b" }, "B")),
        h("main", { id: "main" }, children),
    );
}

function PageA({ label }: { label?: string }) {
    const router = useRouter();
    const [params, setParams] = useSearchParams();
    const [clicks, setClicks] = useState(0);
    latest.setParams = setParams;
    latest.params = params;
    latest.router = router;
    countMount("A");
    useNavigationEffects(behavior.pageEffects);
    useBlocker(() => behavior.blocked, behavior.blockerOptions);
    return h(
        "section",
        { id: "page" },
        h("p", { id: "who" }, `A ${label}`),
        h("p", { id: "q" }, params.get("q") ?? ""),
        h("p", { id: "hash" }, router.hash),
        h("p", { id: "params" }, JSON.stringify(router.params)),
        h("button", { id: "clicks", onClick: () => setClicks((c) => c + 1) }, `clicks ${clicks}`),
        h("a", { id: "plain-b", href: "/b" }, "plain B"),
        h("a", { id: "plain-b-shallow", href: "/?q=shallow", "data-router-shallow": "" }, "shallow"),
        h("a", { id: "plain-nopre", href: "/b", "data-router-prefetch": "false" }, "no prefetch"),
        h("a", { id: "plain-blank", href: "/b", target: "_blank" }, "blank"),
        h(Link, { id: "link-nopre", href: "/b", prefetch: false }, "link no prefetch"),
    );
}

function PageB({ label }: { label?: string }) {
    const [clicks, setClicks] = useState(0);
    countMount("B");
    useBlocker(() => behavior.blocked, behavior.blockerOptions);
    return h(
        "section",
        { id: "page" },
        h("p", { id: "who" }, `B ${label}`),
        h("button", { id: "clicks", onClick: () => setClicks((c) => c + 1) }, `clicks ${clicks}`),
    );
}

function PageItem({ params }: { params?: { id?: string } }) {
    const [clicks, setClicks] = useState(0);
    countMount("Item");
    useBlocker(() => behavior.blocked, behavior.blockerOptions);
    return h(
        "section",
        { id: "page" },
        h("p", { id: "who" }, `item ${params?.id}`),
        h("button", { id: "clicks", onClick: () => setClicks((c) => c + 1) }, `clicks ${clicks}`),
    );
}

function PageBoom() {
    throw new Error("page broke");
}

const loads = {
    a: vi.fn(async () => ({ default: PageA })),
    b: vi.fn(async () => ({ default: PageB })),
    item: vi.fn(async () => ({ default: PageItem })),
    boom: vi.fn(async () => ({ default: PageBoom })),
};
const routes = [
    { template: "/", load: loads.a },
    { template: "/b", load: loads.b },
    { template: "/items/:id", load: loads.item },
    { template: "/boom", load: loads.boom },
    { template: "/shell-boom", load: loads.b },
];

// --- The browser ---------------------------------------------------------------------------------------------------

const listeners: Array<{ target: any; type: string; handler: any }> = [];

/** `window`, as the router sees it: the real one, but for what the test needs to watch (and listeners it can take back). */
function makeWin(over: Record<string, any> = {}) {
    const on = (target: any) => (type: string, handler: any) => {
        listeners.push({ target, type, handler });
        target.addEventListener(type, handler);
    };
    const win: any = {
        location: { get href() { return window.location.href; }, assign: vi.fn(), reload: vi.fn() },
        history: window.history,
        scrollX: 0,
        scrollY: 0,
        scrollTo: vi.fn(),
        fetch: vi.fn(),
        confirm: vi.fn(() => true),
        setTimeout: (handler: () => void, ms: number) => window.setTimeout(handler, ms),
        clearTimeout: (handle: any) => window.clearTimeout(handle),
        addEventListener: on(window),
        removeEventListener: (type: string, handler: any) => window.removeEventListener(type, handler),
        sessionStorage: window.sessionStorage,
        ...over,
    };
    return win;
}

/** `document`, as the router sees it. */
function makeDoc() {
    return {
        get head() { return document.head; },
        get body() { return document.body; },
        get readyState() { return document.readyState; },
        get title() { return document.title; },
        set title(value: string) { document.title = value; },
        createElement: (tag: string) => document.createElement(tag),
        getElementById: (id: string) => document.getElementById(id),
        querySelector: (selector: string) => document.querySelector(selector),
        querySelectorAll: (selector: string) => document.querySelectorAll(selector),
        addEventListener: (type: string, handler: any) => {
            listeners.push({ target: document, type, handler });
            document.addEventListener(type, handler);
        },
    };
}

const respond = (payload: any) => ({
    ok: true,
    redirected: false,
    headers: { get: () => "application/json" },
    json: async () => payload,
});

/** The server, for the test's fetch: what each URL's page is, and the props it's given. */
function serve(href: string, init?: any) {
    const url = new URL(href);
    let route = url.pathname;
    let params: Record<string, string> = {};
    const item = /^\/items\/(\w+)$/.exec(url.pathname);
    if (item) {
        route = "/items/:id";
        params = { id: item[1] };
    }
    expect(init.headers[NAVIGATION_HEADER]).toBe("1");
    return respond({ route, props: { params, label: url.pathname + url.search }, css: [], title: `Title ${url.pathname}` });
}

interface Mounted {
    router: Router;
    win: any;
    doc: any;
    errors: any[];
}

/**
 * Server-renders `path` (the shell around the page, or just the page) into the document exactly as `ReactRoute` does,
 * then starts the router on it, as the router entry does in the browser.
 */
async function mount(
    path = "/",
    over: { shell?: boolean; served?: boolean; options?: StartRouterOptions; win?: Record<string, any>; hash?: string } = {},
): Promise<Mounted> {
    const { shell = true, served = shell, options = { shell: Shell }, hash = "" } = over;
    // A new entry, at the end of the session history: what the router thinks a page it didn't make is.
    window.history.pushState(null, "", path + hash);
    const url = new URL(path, "http://localhost:3000");
    const item = /^\/items\/(\w+)$/.exec(url.pathname);
    const route = item ? "/items/:id" : url.pathname;
    const params = item ? { id: item[1] } : {};
    const props = { params, label: url.pathname + url.search };
    const Page = ({ "/": PageA, "/b": PageB, "/items/:id": PageItem } as any)[route];
    const page = h(Page, props);
    const html = renderToString(
        h(
            "div",
            { id: "react-root" },
            h(RouterProvider, { location: { pathname: url.pathname, search: url.search, params, route } }, served ? h(Shell, props, page) : page),
        ),
    );
    const config = { prefix: "", route, rootId: "react-root", propsId: "react-props", css: [], ...(served ? { shell: true } : {}) };
    document.body.innerHTML =
        html +
        `<script type="application/json" id="${ROUTER_CONFIG_ID}">${JSON.stringify(config)}</script>` +
        `<script type="application/json" id="react-props">${JSON.stringify(props)}</script>`;

    const win = makeWin(over.win);
    win.fetch.mockImplementation(async (href: string, init: any) => serve(href, init));
    const doc = makeDoc();
    let router: Router | undefined;
    await act(async () => {
        router = await startRouter(routes, options, win, doc);
    });
    return { router: router!, win, doc, errors: vi.mocked(console.error).mock.calls };
}

const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
const text = (selector: string) => $(selector)?.textContent;

/** Runs `fn` — a navigation, a click — and lets React finish rendering what it caused. */
async function settled<T>(fn: () => T | Promise<T>): Promise<T> {
    let result!: T;
    await act(async () => {
        result = await fn();
    });
    return result;
}

/** Lets the browser get on with what it was asked to do (the events history traversals queue). */
async function pause(ms: number) {
    await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, ms));
    });
}

/** Moves through the session history, and waits for the browser to have told the router. */
async function traverse(delta: number, wait = 80) {
    await act(async () => {
        window.history.go(delta);
        await new Promise((resolve) => window.setTimeout(resolve, wait));
    });
}

beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    log.shellMounts = 0;
    log.shellUnmounts = 0;
    log.mounts = {};
    behavior.shellEffects = {};
    behavior.pageEffects = {};
    behavior.blocked = false;
    behavior.blockerOptions = undefined;
    behavior.shellThrows = false;
    document.title = "before";
});

afterEach(async () => {
    // Nothing of a test's router is left listening for the next test's.
    for (const { target, type, handler } of listeners.splice(0)) target.removeEventListener(type, handler);
    await act(async () => {
        document.body.innerHTML = "";
    });
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

// --- The tests -----------------------------------------------------------------------------------------------------

describe("the shell, in the browser", () => {
    describe("hydration", () => {
        it("hydrates the shell around the page as one root, agreeing with the server's markup", async () => {
            const { errors } = await mount("/");

            expect($("#shell #main #page #who")?.textContent).toBe("A /");
            expect(log.shellMounts).toBe(1);
            expect(log.mounts).toEqual({ A: 1 });
            // Not a mismatch, and not a crash: the tree hydrated is the tree that was rendered.
            expect(errors).toEqual([]);
        });

        it("is interactive: the shell's state and the page's both work", async () => {
            await mount("/");
            await settled(() => $("#count").click());
            await settled(() => $("#count").click());
            await settled(() => $("#clicks").click());

            expect(text("#count")).toBe("count 2");
            expect(text("#clicks")).toBe("clicks 1");
        });

        it("hydrates the page alone when the server rendered no shell, even if the client has one", async () => {
            const { errors } = await mount("/", { shell: true, served: false });

            expect($("#shell")).toBeNull();
            expect($("#page #who")?.textContent).toBe("A /");
            expect(errors).toEqual([]);
        });

        it("says so, and starts nothing, when the server rendered a shell the client build doesn't have", async () => {
            const { router, errors } = await mount("/", { shell: true, served: true, options: {} });

            expect(router).toBeUndefined();
            expect(errors[0][0]).toContain("shell (_shell.tsx)");
        });

        it("has the location's #fragment once hydrated, though the markup was rendered without one", async () => {
            const { errors } = await mount("/", { hash: "#frag" });

            expect(text("#hash")).toBe("#frag");
            expect(errors).toEqual([]);
        });
    });

    describe("navigating", () => {
        it("keeps the shell mounted — the same element, its state, its effects — and swaps the page inside it", async () => {
            const { router } = await mount("/");
            await settled(() => $("#count").click());
            const shell = $("#shell");

            expect(await settled(() => router.navigate("/b"))).toBe(true);

            expect($("#shell")).toBe(shell);
            expect(text("#count")).toBe("count 1");
            expect(text("#who")).toBe("B /b");
            expect(log.shellMounts).toBe(1);
            expect(log.shellUnmounts).toBe(0);
            expect(log.mounts).toEqual({ A: 1, B: 1 });
        });

        it("remounts the page on every navigation, even to the page that was showing (its state starts over)", async () => {
            const { router } = await mount("/");
            await settled(() => $("#clicks").click());
            expect(text("#clicks")).toBe("clicks 1");

            await settled(() => router.navigate("/b"));
            await settled(() => router.navigate("/"));

            expect(text("#who")).toBe("A /");
            expect(text("#clicks")).toBe("clicks 0");
            expect(log.mounts).toEqual({ A: 2, B: 1 });
            expect(log.shellMounts).toBe(1);
        });

        it("gives the shell the props of the page now showing, and the router state as it changes", async () => {
            const { router } = await mount("/");
            expect($("#shell").getAttribute("data-label")).toBe("/");

            await settled(() => router.navigate("/b"));

            expect($("#shell").getAttribute("data-label")).toBe("/b");
            expect($("#shell").getAttribute("data-path")).toBe("/b");
            // (`NavLink`s in the shell follow.)
            expect($("#link-b").getAttribute("aria-current")).toBe("page");
            expect($("#link-a").getAttribute("aria-current")).toBeNull();
        });

        it("follows a click on a link in the shell or in the page, and updates the title", async () => {
            await mount("/");
            await settled(() => $("#link-b").click());
            expect(text("#who")).toBe("B /b");
            expect(document.title).toBe("Title /b");
            expect(window.location.pathname).toBe("/b");
        });

        it("remounts the page for another :param of the same route, but not the shell", async () => {
            const { router } = await mount("/items/1");
            await settled(() => $("#clicks").click());

            await settled(() => router.navigate("/items/2"));

            expect(text("#who")).toBe("item 2");
            expect(text("#clicks")).toBe("clicks 0");
            expect(log.shellMounts).toBe(1);
        });

        it("leaves a page outside the app to the browser, with the shell where it was", async () => {
            const { router, win } = await mount("/");

            expect(await settled(() => router.navigate("/elsewhere"))).toBe(false);

            expect(win.location.assign).toHaveBeenCalledWith("http://localhost:3000/elsewhere");
            expect($("#shell")).not.toBeNull();
            expect(log.shellUnmounts).toBe(0);
        });
    });

    describe("a page that fails to render", () => {
        it("doesn't take the shell with it: the shell stays, the page is left blank, and the server is asked to render it", async () => {
            const { router, win } = await mount("/");
            await settled(() => $("#count").click());
            const shell = $("#shell");

            await settled(() => router.navigate("/boom"));

            expect($("#shell")).toBe(shell);
            expect(text("#count")).toBe("count 1");
            expect($("#main").textContent).toBe("");
            expect(win.location.reload).toHaveBeenCalledTimes(1);
            expect(log.shellUnmounts).toBe(0);
        });

        it("recovers on the next navigation: the page after it shows, in the same shell", async () => {
            const { router } = await mount("/");
            const shell = $("#shell");
            await settled(() => router.navigate("/boom"));

            await settled(() => router.navigate("/b"));

            expect(text("#who")).toBe("B /b");
            expect($("#shell")).toBe(shell);
        });

        it("doesn't reload again for the same URL, so it can't loop", async () => {
            const { router, win } = await mount("/");
            await settled(() => router.navigate("/boom"));
            expect(win.location.reload).toHaveBeenCalledTimes(1);
            expect(window.sessionStorage.getItem(RECOVERY_KEY)).toBe(window.location.href);

            await settled(() => router.navigate("/b"));
            await settled(() => router.navigate("/boom"));
            await settled(() => router.navigate("/b"));
            await settled(() => router.navigate("/boom"));

            // (Once per URL it recovered from that wasn't the last: `/boom` again is the URL it last tried.)
            expect(win.location.reload.mock.calls.length).toBeLessThanOrEqual(2);
        });

        it("handles a shell that fails as the failure of the whole document: the server is asked to render it", async () => {
            behavior.shellThrows = true;
            const { router, win } = await mount("/");

            await settled(() => router.navigate("/shell-boom"));

            expect(win.location.reload).toHaveBeenCalledTimes(1);
            expect(console.error).toHaveBeenCalledWith(expect.stringContaining("failed to render"), expect.any(Error));
        });
    });

    describe("pending", () => {
        it("is on for what asks while a navigation is in flight, and off when it's done", async () => {
            const { router, win } = await mount("/");
            let release!: () => void;
            win.fetch.mockImplementation(
                (href: string, init: any) => new Promise((resolve) => (release = () => resolve(serve(href, init)))),
            );
            expect($("#shell").getAttribute("data-pending")).toBe("false");

            let navigation!: Promise<boolean>;
            await settled(() => {
                navigation = router.navigate("/b");
            });
            expect(router.isPending()).toBe(true);
            expect($("#shell").getAttribute("data-pending")).toBe("true");
            // What's on screen is still the page being left.
            expect(text("#who")).toBe("A /");

            await settled(async () => {
                release();
                await navigation;
            });

            expect($("#shell").getAttribute("data-pending")).toBe("false");
            expect(text("#who")).toBe("B /b");
        });

        it("marks the root with data-router-pending and aria-busy, if asked to, for the same time", async () => {
            const { router, win } = await mount("/", { options: { shell: Shell, pendingAttributes: true } });
            let release!: () => void;
            win.fetch.mockImplementation(
                (href: string, init: any) => new Promise((resolve) => (release = () => resolve(serve(href, init)))),
            );

            let navigation!: Promise<boolean>;
            await settled(() => {
                navigation = router.navigate("/b");
            });
            expect($("#react-root").getAttribute("data-router-pending")).toBe("true");
            expect($("#react-root").getAttribute("aria-busy")).toBe("true");

            await settled(async () => {
                release();
                await navigation;
            });
            expect($("#react-root").hasAttribute("data-router-pending")).toBe(false);
            expect($("#react-root").hasAttribute("aria-busy")).toBe(false);
        });
    });
});

describe("shallow navigation and search params, in the browser", () => {
    it("keeps the page instance when the query changes with setSearchParams(), and updates what reads it", async () => {
        await mount("/");
        await settled(() => $("#clicks").click());
        const before = window.history.length;

        await settled(() => latest.setParams({ q: "x" }));

        expect(text("#q")).toBe("x");
        expect(window.location.search).toBe("?q=x");
        expect(text("#clicks")).toBe("clicks 1");
        expect(log.mounts).toEqual({ A: 1 });
        expect(window.history.length).toBe(before + 1);
        expect(latest.params?.get("q")).toBe("x");
    });

    it("builds a new query from the current one with a function, and each update builds on the one before it", async () => {
        await mount("/?keep=1");

        await settled(() => {
            latest.setParams((prev: URLSearchParams) => ({ ...Object.fromEntries(prev), q: "a" }));
            latest.setParams((prev: URLSearchParams) => ({ ...Object.fromEntries(prev), page: "2" }));
        });

        expect(window.location.search).toBe("?keep=1&q=a&page=2");
        expect(log.mounts).toEqual({ A: 1 });
    });

    it("replaces the history entry when asked to, and keeps the #fragment", async () => {
        await mount("/", { hash: "#frag" });
        const before = window.history.length;

        await settled(() => latest.setParams({ q: "y" }, { replace: true }));

        expect(window.history.length).toBe(before);
        expect(window.location.search + window.location.hash).toBe("?q=y#frag");
    });

    it("remounts the page instead, with `shallow: false`", async () => {
        await mount("/");
        await settled(() => $("#clicks").click());

        await settled(() => latest.setParams({ q: "z" }, { shallow: false }));
        await settled(() => new Promise((resolve) => window.setTimeout(resolve, 0)));

        expect(text("#q")).toBe("z");
        expect(text("#clicks")).toBe("clicks 0");
        expect(log.mounts).toEqual({ A: 2 });
    });

    it("keeps the instance for a shallow navigation to another :param of the same route, and updates the params", async () => {
        const { router } = await mount("/items/1");
        await settled(() => $("#clicks").click());

        await settled(() => router.navigate("/items/2", { shallow: true }));

        expect(window.location.pathname).toBe("/items/2");
        expect(text("#clicks")).toBe("clicks 1");
        expect(log.mounts).toEqual({ Item: 1 });
        // (The page's `params` prop follows the URL, though its other props weren't fetched again.)
        expect(text("#who")).toBe("item 2");
    });

    it("fetches the page's props again for a shallow navigation, when asked to, keeping the instance", async () => {
        const { router, win } = await mount("/");
        await settled(() => $("#clicks").click());
        win.fetch.mockClear();

        await settled(() => router.navigate("/?q=fresh", { shallow: true, refetch: true }));

        expect(win.fetch).toHaveBeenCalledTimes(1);
        expect(text("#who")).toBe("A /?q=fresh");
        expect(text("#clicks")).toBe("clicks 1");
        expect(document.title).toBe("Title /");
    });

    it("does not ask a blocker: the page, and what's in it, is still there", async () => {
        const { router, win } = await mount("/");
        behavior.blocked = true;

        await settled(() => router.navigate("/?q=1", { shallow: true }));
        await settled(() => router.navigate("#frag"));

        expect(win.confirm).not.toHaveBeenCalled();
        expect(text("#hash")).toBe("#frag");
    });

    it("takes a plain link marked data-router-shallow, keeping the page instance", async () => {
        await mount("/");
        await settled(() => $("#clicks").click());

        await settled(() => $("#plain-b-shallow").click());

        expect(window.location.search).toBe("?q=shallow");
        expect(text("#clicks")).toBe("clicks 1");
        expect(log.mounts).toEqual({ A: 1 });
    });

    it("goes back and forward over shallow navigations without remounting the page", async () => {
        await mount("/");
        await settled(() => latest.setParams({ q: "1" }));
        await settled(() => latest.setParams({ q: "2" }));
        await settled(() => $("#clicks").click());

        await traverse(-1);
        expect(window.location.search).toBe("?q=1");
        expect(text("#q")).toBe("1");
        expect(text("#clicks")).toBe("clicks 1");

        await traverse(-1);
        expect(window.location.search).toBe("");
        expect(text("#q")).toBe("");

        await traverse(2);
        expect(window.location.search).toBe("?q=2");
        expect(text("#q")).toBe("2");
        expect(log.mounts).toEqual({ A: 1 });
        expect(text("#clicks")).toBe("clicks 1");
    });

    it("updates the hash for what reads it when only the #fragment changes, and doesn't remount", async () => {
        const { router } = await mount("/");
        await settled(() => $("#clicks").click());

        await settled(() => router.navigate("#one"));
        expect(text("#hash")).toBe("#one");

        await traverse(-1);
        expect(text("#hash")).toBe("");
        expect(text("#clicks")).toBe("clicks 1");
        expect(log.mounts).toEqual({ A: 1 });
    });
});

describe("navigation blockers, in the browser", () => {
    it("asks before a client navigation, and drops it when the user says no", async () => {
        const { router, win } = await mount("/");
        behavior.blocked = true;
        win.confirm.mockReturnValue(false);

        expect(await settled(() => router.navigate("/b"))).toBe(false);

        expect(win.confirm).toHaveBeenCalledWith(expect.stringContaining("unsaved changes"));
        expect(text("#who")).toBe("A /");
        expect(window.location.pathname).toBe("/");
        expect(win.fetch).not.toHaveBeenCalled();
    });

    it("lets the navigation go ahead when the user says yes, and asks with the page's message", async () => {
        behavior.blocked = true;
        behavior.blockerOptions = "Discard the draft?";
        const { router, win } = await mount("/");

        expect(await settled(() => router.navigate("/b"))).toBe(true);

        expect(win.confirm).toHaveBeenCalledWith("Discard the draft?");
        expect(text("#who")).toBe("B /b");
    });

    it("doesn't ask while nothing is at stake", async () => {
        const { router, win } = await mount("/");
        await settled(() => router.navigate("/b"));
        expect(win.confirm).not.toHaveBeenCalled();
    });

    it("asks a click on a link too, and takes the answer from onBlock when there is one", async () => {
        const onBlock = vi.fn(async () => false);
        behavior.blocked = true;
        behavior.blockerOptions = { onBlock };
        const { win } = await mount("/");

        await settled(() => $("#link-b").click());

        expect(onBlock).toHaveBeenCalledWith({ to: "http://localhost:3000/b" });
        expect(win.confirm).not.toHaveBeenCalled();
        expect(text("#who")).toBe("A /");
    });

    it("is gone with the page that asked: the next page doesn't block", async () => {
        const { router, win } = await mount("/");
        behavior.blocked = true;
        await settled(() => router.navigate("/b"));
        behavior.blocked = false;

        await settled(() => router.navigate("/"));

        expect(win.confirm).toHaveBeenCalledTimes(1);
    });

    it("asks before the tab is closed or reloaded, only while there's something to lose", async () => {
        await mount("/");
        const quiet = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(quiet);
        expect(quiet.defaultPrevented).toBe(false);

        behavior.blocked = true;
        const asking = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(asking);
        expect(asking.defaultPrevented).toBe(true);
    });

    describe("back and forward", () => {
        it("puts the browser back where it was when the user refuses to leave, and lets them try again", async () => {
            const { router, win } = await mount("/");
            await settled(() => router.navigate("/b"));
            await settled(() => router.navigate("/items/1"));
            behavior.blocked = true;
            win.confirm.mockReturnValue(false);
            const index = window.history.state.rrIndex;

            await traverse(-1);
            await pause(60);

            // The user stayed: the address bar, the entry, and the page all say where they were.
            expect(window.location.pathname).toBe("/items/1");
            expect(window.history.state.rrIndex).toBe(index);
            expect(text("#who")).toBe("item 1");
            expect(win.confirm).toHaveBeenCalledTimes(1);

            // ...and the entries around it are still there: going back for real works, and so does going forward again.
            win.confirm.mockReturnValue(true);
            await traverse(-1);
            expect(window.location.pathname).toBe("/b");
            expect(text("#who")).toBe("B /b");
            await traverse(1);
            expect(window.location.pathname).toBe("/items/1");
            expect(text("#who")).toBe("item 1");
        });

        it("also refuses going forward, restoring the entry it was on", async () => {
            const { router, win } = await mount("/");
            await settled(() => router.navigate("/b"));
            await traverse(-1);
            expect(window.location.pathname).toBe("/");
            behavior.blocked = true;
            win.confirm.mockReturnValue(false);

            await traverse(1);
            await pause(60);

            expect(window.location.pathname).toBe("/");
            expect(text("#who")).toBe("A /");
        });

        it("adds an entry for the page still showing when the entry it was on wasn't the router's to know", async () => {
            const { router, win } = await mount("/");
            await settled(() => router.navigate("/b"));
            // An entry made behind the router's back (a hand-made pushState with no state of its own), then a
            // back to the router's page from it: where in history that entry is, isn't something it knows.
            window.history.pushState(null, "", "/foreign");
            await traverse(-1);
            expect(window.location.pathname).toBe("/b");
            await traverse(-1);
            expect(window.location.pathname).toBe("/");
            behavior.blocked = true;
            win.confirm.mockReturnValue(false);
            const length = window.history.length;

            await traverse(1);
            await pause(60);

            expect(window.location.pathname).toBe("/");
            expect(text("#who")).toBe("A /");
            expect(window.history.length).toBeGreaterThanOrEqual(length);
        });
    });
});

describe("navigation effects, in the browser", () => {
    it("moves focus to the app's root by default, as a page load would have put it back at the start", async () => {
        const { router } = await mount("/");

        await settled(() => router.navigate("/b"));

        expect(document.activeElement).toBe($("#react-root"));
        expect($("#react-root").getAttribute("tabindex")).toBe("-1");
    });

    it("moves focus to the element a shell chose, making it focusable by script", async () => {
        behavior.shellEffects = { focus: "#main" };
        const { router } = await mount("/");

        await settled(() => router.navigate("/b"));

        expect(document.activeElement).toBe($("#main"));
        expect($("#main").getAttribute("tabindex")).toBe("-1");
    });

    it("lets the page on screen override the shell's choice — from the very first render too, though its effects run first", async () => {
        behavior.shellEffects = { focus: "#main", scroll: "preserve" };
        behavior.pageEffects = { focus: "#page" };
        const { router } = await mount("/");

        // The page (A) rendered after the shell, so its focus wins; what only the shell says holds.
        expect(router.effects()).toEqual({ focus: "#page", scroll: "preserve" });

        // Leaving that page takes its overrides with it.
        await settled(() => router.navigate("/b"));
        expect(router.effects()).toEqual({ focus: "#main", scroll: "preserve" });
        expect(document.activeElement).toBe($("#main"));
    });

    it("announces the new page to screen readers in a polite live region outside the React tree", async () => {
        behavior.shellEffects = { announce: ({ title, pathname }) => `Navigated to ${title} (${pathname})` };
        const { router } = await mount("/");
        expect($("[role=status]")).toBeNull();

        await settled(() => router.navigate("/b"));
        await settled(() => new Promise((resolve) => window.setTimeout(resolve, ANNOUNCE_DELAY_MS + 30)));

        const region = $("[role=status]");
        expect(region.getAttribute("aria-live")).toBe("polite");
        expect(region.parentElement).toBe(document.body);
        expect(region.textContent).toBe("Navigated to Title /b (/b)");
        // It's the same region next time, cleared first so that an announcement identical to the last is spoken again.
        await settled(() => router.navigate("/"));
        expect(document.querySelectorAll("[role=status]")).toHaveLength(1);
    });

    it("leaves the scroll position alone when the shell says the router shouldn't touch it", async () => {
        behavior.shellEffects = { scroll: false };
        const { router, win } = await mount("/");

        await settled(() => router.navigate("/b"));

        expect(win.scrollTo).not.toHaveBeenCalled();
    });
});

describe("prefetching, in the browser", () => {
    it("warms a plain link's page when it's pointed at, pressed or focused, if asked to", async () => {
        const { win } = await mount("/", { options: { shell: Shell, prefetch: { links: true } } });

        await settled(() => $("#plain-b").dispatchEvent(new Event("pointerover", { bubbles: true })));

        expect(loads.b).toHaveBeenCalledTimes(1);
        expect(win.fetch).toHaveBeenCalledTimes(1);
        expect(win.fetch.mock.calls[0][0]).toBe("http://localhost:3000/b");
        // (Once is enough: the second sign of intent finds it already on its way.)
        await settled(() => $("#plain-b").dispatchEvent(new Event("focusin", { bubbles: true })));
        expect(win.fetch).toHaveBeenCalledTimes(1);
    });

    it("leaves plain links alone unless asked to", async () => {
        const { win } = await mount("/");
        await settled(() => $("#plain-b").dispatchEvent(new Event("pointerover", { bubbles: true })));
        expect(win.fetch).not.toHaveBeenCalled();
    });

    it("leaves alone a link that opts out, one that opens elsewhere, and a Link with prefetch off", async () => {
        const { win } = await mount("/", { options: { shell: Shell, prefetch: { links: true } } });
        for (const id of ["plain-nopre", "plain-blank", "link-nopre"]) {
            await settled(() => $("#" + id).dispatchEvent(new Event("pointerdown", { bubbles: true })));
        }
        expect(win.fetch).not.toHaveBeenCalled();
        expect(loads.b).not.toHaveBeenCalled();
    });

    it("prefetches the listed pages' code when the browser is idle, and not their data unless asked to", async () => {
        const { win } = await mount("/", { options: { shell: Shell, prefetch: { idle: ["/b", "/items/9"] } } });
        expect(loads.b).not.toHaveBeenCalled();

        await settled(() => new Promise((resolve) => window.setTimeout(resolve, 300)));

        expect(loads.b).toHaveBeenCalledTimes(1);
        expect(loads.item).toHaveBeenCalledTimes(1);
        expect(win.fetch).not.toHaveBeenCalled();
    });

    it("prefetches their data too with prefetch.data", async () => {
        const { win } = await mount("/", { options: { shell: Shell, prefetch: { idle: ["/b"], data: true } } });

        await settled(() => new Promise((resolve) => window.setTimeout(resolve, 300)));

        expect(win.fetch).toHaveBeenCalledTimes(1);
    });

    it("prefetches nothing ahead of any sign of intent when the user asked to save data", async () => {
        await mount("/", {
            options: { shell: Shell, prefetch: { idle: ["/b"] } },
            win: { navigator: { connection: { saveData: true } } },
        });

        await settled(() => new Promise((resolve) => window.setTimeout(resolve, 300)));

        expect(loads.b).not.toHaveBeenCalled();
    });
});

