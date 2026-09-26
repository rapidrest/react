///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { vi } from "vitest";
import { ANNOUNCE_DELAY_MS, createBrowserPlatform, startRouter } from "../src/router.js";
import { useRouter } from "../src/routerContext.js";
import { NavigationEffects, ROUTER_CONFIG_ID } from "../src/routerCore.js";

vi.mock("react-dom/client", () => ({ hydrateRoot: vi.fn() }));
vi.mock("react-dom", () => ({ flushSync: (fn: () => void) => fn() }));

/*
 * What the router does in a browser beyond the basics in router.test.ts, against a fake `window` and `document`: the
 * platform's history bookkeeping and its effects (scroll, focus, announcements), and what `startRouter()` builds and wires up
 * for the shell, the options and the listeners. (The same code under a real DOM and React is in shell.dom.test.ts.)
 */

const HREF = "https://example.com/admin/users/7?tab=1";

function makeWindow(href = HREF, over: Record<string, any> = {}) {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const timers: Array<() => void> = [];
    const win: any = {
        location: { href, assign: vi.fn(), reload: vi.fn() },
        history: { state: null as any, length: 3, scrollRestoration: "auto", pushState: vi.fn(), replaceState: vi.fn(), go: vi.fn() },
        confirm: vi.fn(() => true),
        clearTimeout: vi.fn(),
        removeEventListener: vi.fn(),
        scrollX: 10,
        scrollY: 20,
        scrollTo: vi.fn(),
        fetch: vi.fn(),
        setTimeout: vi.fn((handler: () => void) => timers.push(handler)),
        addEventListener: vi.fn((type: string, handler: (event: any) => void) => {
            (listeners[type] ??= []).push(handler);
        }),
        sessionStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
        ...over,
    };
    return { win, listeners, timers };
}

function makeDocument(elements: Record<string, any> = {}) {
    const listeners: Record<string, Array<(event: any) => void>> = {};
    const links: any[] = [];
    const doc: any = {
        head: { appendChild: vi.fn((node: any) => links.push(node)) },
        body: { appendChild: vi.fn() },
        createElement: vi.fn(() => ({ setAttribute: vi.fn(), style: {} })),
        getElementById: vi.fn((id: string) => elements[id] ?? null),
        querySelector: vi.fn(() => null),
        querySelectorAll: vi.fn((selector: string) =>
            selector.startsWith("script")
                ? Object.entries(elements)
                      .filter(([, element]) => element && "textContent" in element)
                      .map(([id, element]) => ({ ...element, id }))
                : links.filter((l) => l.rel === "stylesheet"),
        ),
        title: "Page title",
        readyState: "complete",
        addEventListener: vi.fn((type: string, handler: (event: any) => void) => {
            (listeners[type] ??= []).push(handler);
        }),
    };
    return { doc, listeners, links };
}

function makeContainer() {
    return { focus: vi.fn(), setAttribute: vi.fn(), removeAttribute: vi.fn(), style: { outline: "" } };
}

describe("createBrowserPlatform", () => {
    function setup(hooks: any = {}, href = HREF) {
        const { win, timers } = makeWindow(href);
        const { doc } = makeDocument();
        const container = makeContainer();
        const platform = createBrowserPlatform(win, doc, container, vi.fn(), [], hooks);
        return { win, doc, timers, container, platform };
    }
    const url = (hash = "") => new URL("https://example.com/admin/users/8" + hash);

    describe("history", () => {
        it("adds an entry that records its place in the session history, right after the entry it leaves", () => {
            const { platform, win } = setup();
            win.history.state = { rrIndex: 4 };

            platform.commitHistory(url(), "push");

            expect(win.history.pushState).toHaveBeenCalledWith({ rrIndex: 5 }, "", url().href);
            // (The entry it left already had its place recorded.)
            expect(win.history.replaceState).not.toHaveBeenCalled();
        });

        it("records the place of an entry that has none, before leaving it: the last one, which is what a page just loaded is", () => {
            const { platform, win } = setup();
            win.history.state = { rrScroll: { x: 1, y: 2 } };

            platform.commitHistory(url(), "push");

            expect(win.history.replaceState).toHaveBeenCalledWith({ rrScroll: { x: 1, y: 2 }, rrIndex: 2 }, "");
            expect(win.history.pushState).toHaveBeenCalledWith({ rrIndex: 3 }, "", url().href);

            win.history.state = null;
            platform.commitHistory(url(), "push");
            expect(win.history.replaceState).toHaveBeenLastCalledWith({ rrIndex: 2 }, "");
        });

        it("marks an entry made by a shallow navigation", () => {
            const { platform, win } = setup();
            win.history.state = { rrIndex: 0 };

            platform.commitHistory(url(), "push", true);
            expect(win.history.pushState).toHaveBeenCalledWith({ rrIndex: 1, rrShallow: true }, "", url().href);

            platform.commitHistory(url(), "replace", true);
            expect(win.history.replaceState).toHaveBeenCalledWith({ rrIndex: 0, rrShallow: true }, "", url().href);
        });

        it("replaces an entry in place, keeping its place in the session history", () => {
            const { platform, win } = setup();
            win.history.state = { rrIndex: 7 };
            platform.commitHistory(url(), "replace");
            expect(win.history.replaceState).toHaveBeenCalledWith({ rrIndex: 7 }, "", url().href);
            expect(win.history.pushState).not.toHaveBeenCalled();
        });

        it("reads back what it recorded on the entry the browser is at, and nothing where it recorded none", () => {
            const { platform, win } = setup();
            win.history.state = { rrIndex: 3, rrShallow: true };
            expect(platform.historyEntry()).toEqual({ index: 3, shallow: true });
            win.history.state = { rrIndex: 0 };
            expect(platform.historyEntry()).toEqual({ index: 0, shallow: false });
            win.history.state = { rrIndex: "3" };
            expect(platform.historyEntry()).toEqual({ index: null, shallow: false });
            win.history.state = null;
            expect(platform.historyEntry()).toEqual({ index: null, shallow: false });
        });

        it("moves through the session history", () => {
            const { platform, win } = setup();
            platform.historyGo(-2);
            expect(win.history.go).toHaveBeenCalledWith(-2);
        });
    });

    describe("settle, with the app's effects", () => {
        const withEffects = (effects: NavigationEffects) => setup({ effects: () => effects });

        it("scrolls to the top and focuses the container without any", () => {
            const { platform, win, container } = setup();
            platform.settle(url(), { restore: false, scroll: true });
            expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
            expect(container.focus).toHaveBeenCalledWith({ preventScroll: true });
        });

        it("doesn't touch the scroll position at all with scroll: false, not even to restore it — and still focuses", () => {
            const { platform, win, container } = withEffects({ scroll: false });
            win.history.state = { rrScroll: { x: 5, y: 300 } };
            platform.settle(url("#x"), { restore: true, scroll: true });
            platform.settle(url(), { restore: false, scroll: true });
            expect(win.scrollTo).not.toHaveBeenCalled();
            expect(container.focus).toHaveBeenCalledTimes(2);
        });

        it("leaves a new page where the scroll position is with scroll: 'preserve', but still goes to a #fragment and restores", () => {
            const { platform, win, doc } = withEffects({ scroll: "preserve" });
            platform.settle(url(), { restore: false, scroll: true });
            expect(win.scrollTo).not.toHaveBeenCalled();

            const target = { scrollIntoView: vi.fn() };
            doc.getElementById.mockReturnValueOnce(target);
            platform.settle(url("#part"), { restore: false, scroll: true });
            expect(target.scrollIntoView).toHaveBeenCalled();

            win.history.state = { rrScroll: { x: 1, y: 2 } };
            platform.settle(url(), { restore: true, scroll: true });
            expect(win.scrollTo).toHaveBeenCalledWith(1, 2);
        });

        it("scrolls to the top with scroll: 'top', as by default", () => {
            const { platform, win } = withEffects({ scroll: "top" });
            platform.settle(url(), { restore: false, scroll: true });
            expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
        });

        it("leaves focus where it is with focus: false", () => {
            const { platform, container } = withEffects({ focus: false });
            platform.settle(url(), { restore: false, scroll: true });
            expect(container.focus).not.toHaveBeenCalled();
        });

        it("focuses the element a selector finds, making it focusable by script if it isn't", () => {
            const { platform, doc, container } = withEffects({ focus: "h1" });
            const heading = { focus: vi.fn(), hasAttribute: vi.fn(() => false), setAttribute: vi.fn() };
            doc.querySelector.mockReturnValueOnce(heading);

            platform.settle(url(), { restore: false, scroll: true });

            expect(doc.querySelector).toHaveBeenCalledWith("h1");
            expect(heading.setAttribute).toHaveBeenCalledWith("tabindex", "-1");
            expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
            expect(container.focus).not.toHaveBeenCalled();
        });

        it("leaves an element that already has a tabindex as it is", () => {
            const { platform, doc } = withEffects({ focus: "#a" });
            const element = { focus: vi.fn(), hasAttribute: vi.fn(() => true), setAttribute: vi.fn() };
            doc.querySelector.mockReturnValueOnce(element);
            platform.settle(url(), { restore: false, scroll: true });
            expect(element.setAttribute).not.toHaveBeenCalled();
            expect(element.focus).toHaveBeenCalled();
        });

        it("focuses what a function returns, even something that's only focusable", () => {
            const target = { focus: vi.fn() };
            const { platform, container } = withEffects({ focus: () => target });
            platform.settle(url(), { restore: false, scroll: true });
            expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
            expect(container.focus).not.toHaveBeenCalled();
        });

        it("falls back to the container when the selector matches nothing, isn't a selector, or the function finds nothing", () => {
            const first = withEffects({ focus: "#none" });
            first.platform.settle(url(), { restore: false, scroll: true });
            expect(first.container.focus).toHaveBeenCalledTimes(1);

            const second = withEffects({ focus: "??" });
            second.doc.querySelector.mockImplementationOnce(() => {
                throw new SyntaxError("not a selector");
            });
            second.platform.settle(url(), { restore: false, scroll: true });
            expect(second.container.focus).toHaveBeenCalledTimes(1);

            const third = withEffects({ focus: () => null });
            third.platform.settle(url(), { restore: false, scroll: true });
            expect(third.container.focus).toHaveBeenCalledTimes(1);
        });
    });

    describe("announce", () => {
        const announcing = (announce: NavigationEffects["announce"]) => setup({ effects: () => ({ announce }) });

        it("does nothing without an announcement, or with one that says there's nothing to announce", () => {
            const none = setup();
            none.platform.announce(url());
            for (const text of [false as const, ""]) {
                const { platform, doc } = announcing(() => text);
                platform.announce(url());
                expect(doc.createElement).not.toHaveBeenCalled();
            }
            expect(none.doc.body.appendChild).not.toHaveBeenCalled();
        });

        it("puts the text in a polite, visually hidden status region added to the body, told the title and the path", () => {
            const announce = vi.fn(({ title, pathname }: { title: string; pathname: string }) => `${title} ${pathname}`);
            const { platform, doc, timers, win } = announcing(announce);
            const region: any = { setAttribute: vi.fn(), style: {}, textContent: "old" };
            doc.createElement.mockReturnValueOnce(region);

            platform.announce(url());

            expect(announce).toHaveBeenCalledWith({ title: "Page title", pathname: "/admin/users/8" });
            expect(region.setAttribute).toHaveBeenCalledWith("role", "status");
            expect(region.setAttribute).toHaveBeenCalledWith("aria-live", "polite");
            expect(region.setAttribute).toHaveBeenCalledWith("aria-atomic", "true");
            expect(region.style.cssText).toContain("clip:rect(0 0 0 0)");
            expect(doc.body.appendChild).toHaveBeenCalledWith(region);
            // Emptied first, and the text put in after a moment, so that saying the same thing twice is heard twice.
            expect(region.textContent).toBe("");
            expect(win.setTimeout).toHaveBeenCalledWith(expect.any(Function), ANNOUNCE_DELAY_MS);
            timers[0]();
            expect(region.textContent).toBe("Page title /admin/users/8");
        });

        it("makes the region once, and uses it for every announcement after", () => {
            const { platform, doc } = announcing(() => "hello");
            platform.announce(url());
            platform.announce(url());
            expect(doc.createElement).toHaveBeenCalledTimes(1);
            expect(doc.body.appendChild).toHaveBeenCalledTimes(1);
        });
    });

    describe("pending", () => {
        it("marks the container while a navigation is under way, when asked to", () => {
            const { platform, container } = setup({ pendingAttributes: true });

            platform.setPending(true);
            expect(container.setAttribute).toHaveBeenCalledWith("data-router-pending", "true");
            expect(container.setAttribute).toHaveBeenCalledWith("aria-busy", "true");

            platform.setPending(false);
            expect(container.removeAttribute).toHaveBeenCalledWith("data-router-pending");
            expect(container.removeAttribute).toHaveBeenCalledWith("aria-busy");
        });

        it("leaves the container alone by default", () => {
            const { platform, container } = setup();
            platform.setPending(true);
            platform.setPending(false);
            expect(container.setAttribute).not.toHaveBeenCalledWith("aria-busy", "true");
            expect(container.removeAttribute).not.toHaveBeenCalled();
        });
    });

    it("hands updating the page on screen to what it was given, and asks the user with the window's confirm", () => {
        const update = vi.fn();
        const { platform, win } = setup({ update });
        platform.update({ url: url() });
        expect(update).toHaveBeenCalledWith({ url: url() });

        win.confirm.mockReturnValueOnce(false);
        expect(platform.confirm("Sure?")).toBe(false);
        expect(win.confirm).toHaveBeenCalledWith("Sure?");
    });

    it("has nothing to update, or announce, unless given something to", () => {
        const { platform } = setup();
        expect(() => platform.update({ url: url() })).not.toThrow();
    });
});

describe("startRouter", () => {
    const config = { prefix: "/admin", route: "/users/:id", rootId: "react-root", propsId: "react-props" };

    function Page(props: any) {
        return createElement("p", { "data-hash": useRouter().hash }, `id=${props.id} params=${JSON.stringify(props.params)}`);
    }
    function Shell(props: any) {
        return createElement("div", { id: "shell" }, `label=${props.label}`, props.children);
    }

    function boot(over: { config?: any; win?: Record<string, any>; href?: string } = {}) {
        const container = makeContainer();
        const cfg = over.config ?? config;
        const elements: Record<string, any> = {
            [ROUTER_CONFIG_ID]: { textContent: JSON.stringify(cfg) },
            "react-root": container,
            "react-props": { textContent: JSON.stringify({ id: "7", label: "L", params: { id: "7" } }) },
        };
        const { win, listeners: winListeners, timers } = makeWindow(over.href, over.win);
        const { doc, listeners: docListeners } = makeDocument(elements);
        const load = vi.fn(async () => ({ default: Page }));
        const routes = [
            { template: "/users", load: vi.fn(async () => ({ default: Page })) },
            { template: "/users/:id", load },
        ];
        const render = vi.fn();
        vi.mocked(hydrateRoot).mockReturnValue({ render } as any);
        return { win, doc, winListeners, docListeners, timers, routes, load, render, container };
    }

    const start = (s: ReturnType<typeof boot>, options: any = {}) => startRouter(s.routes, options, s.win, s.doc);
    const hydrated = () => vi.mocked(hydrateRoot).mock.calls[0][1] as any;

    afterEach(() => {
        vi.restoreAllMocks();
        vi.mocked(hydrateRoot).mockReset();
    });

    describe("with a shell", () => {
        const served = { ...config, shell: true };

        it("hydrates the shell around the page, the page inside a boundary of its own, so that the page can fail without the shell", async () => {
            const s = boot({ config: served });
            await start(s, { shell: Shell });

            const element = hydrated();
            // RouterProvider > (shell's boundary) > Shell > (page's boundary) > Page
            const shellBoundary = element.props.children;
            const shell = shellBoundary.props.children;
            expect(shell.type).toBe(Shell);
            expect(shell.props.label).toBe("L");
            const pageBoundary = shell.props.children;
            expect(pageBoundary.type).toBe(shellBoundary.type);
            expect(pageBoundary.props.children.type).toBe(Page);
            expect(renderToString(element)).toBe(
                '<div id="shell">label=L<p data-hash="">id=7 params={&quot;id&quot;:&quot;7&quot;}</p></div>',
            );
        });

        it("has the server's markup and the client's tree agree: no shell around the page when the server rendered none", async () => {
            const s = boot({ config });
            await start(s, { shell: Shell });
            // RouterProvider > (page's boundary) > Page: nothing between the provider and the page.
            expect(hydrated().props.children.props.children.type).toBe(Page);
            expect(renderToString(hydrated())).toBe('<p data-hash="">id=7 params={&quot;id&quot;:&quot;7&quot;}</p>');
        });

        it("says so, and starts nothing, when the server rendered a shell the client doesn't have", async () => {
            const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
            const s = boot({ config: served });

            expect(await start(s)).toBeUndefined();

            expect(error.mock.calls[0][0]).toContain("shell (_shell.tsx)");
            expect(hydrateRoot).not.toHaveBeenCalled();
        });

        it("gives the shell a boundary that has the browser load the page when the shell itself fails", async () => {
            vi.spyOn(console, "error").mockImplementation(() => undefined);
            const s = boot({ config: served });
            await start(s, { shell: Shell });

            hydrated().props.children.props.onError(new Error("shell failed"));

            expect(s.win.location.reload).toHaveBeenCalledTimes(1);
        });

        it("keeps the shell element, and its boundary, the same between navigations, and gives only the page a new key", async () => {
            const s = boot({ config: served });
            const router = (await start(s, { shell: Shell }))!;
            const first = hydrated();
            s.win.fetch.mockResolvedValue({
                ok: true,
                redirected: false,
                headers: { get: () => "application/json" },
                json: async () => ({ route: "/users/:id", props: { id: "9", label: "M", params: { id: "9" } }, css: [] }),
            });

            await router.navigate("/admin/users/9");

            const second = s.render.mock.calls[0][0];
            const [a, b] = [first.props.children, second.props.children];
            expect(a.type).toBe(b.type);
            expect(a.key).toBe(b.key);
            expect(a.props.children.type).toBe(b.props.children.type);
            expect(a.props.children.props.children.key).not.toBe(b.props.children.props.children.key);
            // The shell is given the new page's props.
            expect(b.props.children.props.label).toBe("M");
        });
    });

    describe("updating the page on screen", () => {
        async function running(options: any = {}) {
            const s = boot();
            const router = (await start(s, options))!;
            return { s, router };
        }

        it("keeps the page instance on a shallow update: same key, new location, params carried into its props", async () => {
            const { s, router } = await running();
            const before = hydrated();

            await router.navigate("/admin/users/8?x=1", { shallow: true });

            const after = s.render.mock.calls[0][0];
            expect(after.props.children.key).toBe(before.props.children.key);
            expect(after.props.location).toMatchObject({ pathname: "/admin/users/8", search: "?x=1", params: { id: "8" } });
            expect(after.props.children.props.children.props).toEqual({ id: "7", label: "L", params: { id: "8" } });
            expect(s.render).toHaveBeenCalledTimes(1);
        });

        it("gives the page the props it was fetched again with, as they are", async () => {
            const { s, router } = await running();
            s.win.fetch.mockResolvedValue({
                ok: true,
                redirected: false,
                headers: { get: () => "application/json" },
                json: async () => ({ route: "/users/:id", props: { id: "8", params: { id: "8" } }, css: [] }),
            });

            await router.navigate("/admin/users/8", { shallow: true, refetch: true });

            expect(s.render.mock.calls.at(-1)![0].props.children.props.children.props).toEqual({ id: "8", params: { id: "8" } });
        });

        it("changes only the location for a #fragment, keeping props and params as they were", async () => {
            const { s, router } = await running();

            await router.navigate("#part");

            const after = s.render.mock.calls[0][0];
            expect(after.props.location).toMatchObject({ hash: "#part", params: { id: "7" } });
            expect(after.props.children.props.children.props).toEqual({ id: "7", label: "L", params: { id: "7" } });
        });

        it("follows the URL's #fragment once hydrated, though what it hydrates is what the server rendered, without one", async () => {
            const s = boot({ href: HREF + "#frag" });
            await start(s);

            const element = hydrated();
            expect(element.props.location.hash).toBe("");
            expect(s.render).not.toHaveBeenCalled();

            element.props.onMounted();

            expect(s.render).toHaveBeenCalledTimes(1);
            expect(s.render.mock.calls[0][0].props.location.hash).toBe("#frag");
            // Only once.
            expect(s.render.mock.calls[0][0].props.onMounted).toBeUndefined();
        });

        it("has nothing to do once hydrated when the URL has no #fragment", async () => {
            const s = boot();
            await start(s);
            expect(hydrated().props.onMounted).toBeUndefined();
        });
    });

    describe("the listeners", () => {
        const target = (anchor: any) => ({ target: { closest: vi.fn(() => anchor) } });
        const anchor = (attrs: Record<string, string>) => ({
            getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
            hasAttribute: (name: string) => name in attrs,
        });

        it("marks a plain link that asks to be shallow, and only that one", async () => {
            const s = boot();
            const router = (await start(s))!;
            const navigate = vi.spyOn(router, "navigate").mockResolvedValue(true);
            const event = (a: any) => ({ ...target(a), defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: vi.fn() });

            s.docListeners.click[0](event(anchor({ href: "/admin/users/8", "data-router-shallow": "" })));
            expect(navigate).toHaveBeenLastCalledWith("/admin/users/8", { replace: false, shallow: true });

            s.docListeners.click[0](event(anchor({ href: "/admin/users/8" })));
            expect(navigate).toHaveBeenLastCalledWith("/admin/users/8", { replace: false });
        });

        it("warms a plain link's page when it's pointed at, pressed on or focused, if asked to", async () => {
            const s = boot();
            const router = (await start(s, { prefetch: { links: true } }))!;
            const prefetch = vi.spyOn(router, "prefetch").mockImplementation(() => undefined);

            for (const type of ["pointerover", "pointerdown", "focusin"]) {
                expect(s.docListeners[type]).toHaveLength(1);
                s.docListeners[type][0](target(anchor({ href: "/admin/users/8" })));
            }

            expect(prefetch).toHaveBeenCalledTimes(3);
            expect(prefetch).toHaveBeenCalledWith("/admin/users/8");
        });

        it("doesn't warm plain links unless asked to: it's the server that pays for what is warmed", async () => {
            const s = boot();
            await start(s);
            await start(boot(), { prefetch: { idle: [], links: false } });
            expect(s.docListeners.pointerover).toBeUndefined();
            expect(s.docListeners.pointerdown).toBeUndefined();
            expect(s.docListeners.focusin).toBeUndefined();
        });

        it("doesn't warm what isn't a link, one the router wouldn't take, or one that opted out of it", async () => {
            const s = boot();
            const router = (await start(s, { prefetch: { links: true } }))!;
            const prefetch = vi.spyOn(router, "prefetch").mockImplementation(() => undefined);
            const over = s.docListeners.pointerover[0];

            over({ target: null });
            over({ target: {} });
            over(target(null));
            over(target(anchor({ href: "/x", target: "_blank" })));
            over(target(anchor({ href: "/x", "data-router-ignore": "" })));
            over(target(anchor({ href: "/x", "data-router-prefetch": "false" })));
            over(target(anchor({ name: "no destination" })));

            expect(prefetch).not.toHaveBeenCalled();
        });

        it("asks the browser to prompt before the page is left, only while a blocker is in force", async () => {
            const s = boot();
            const router = (await start(s))!;
            const event = () => ({ preventDefault: vi.fn(), returnValue: undefined as any });

            const quiet = event();
            s.winListeners.beforeunload[0](quiet);
            expect(quiet.preventDefault).not.toHaveBeenCalled();

            router.block({ active: () => true });
            const asking = event();
            s.winListeners.beforeunload[0](asking);
            expect(asking.preventDefault).toHaveBeenCalled();
            expect(asking.returnValue).toBe("");
        });
    });

    describe("prefetching", () => {
        it("prefetches the listed pages' code (not their data) when the browser is idle", async () => {
            const s = boot();
            const router = (await start(s, { prefetch: { idle: ["/admin/users", "/admin/users/9"] } }))!;
            const prefetch = vi.spyOn(router, "prefetch").mockImplementation(() => undefined);

            // No requestIdleCallback in this window, so the load is followed by a short timer.
            expect(s.win.setTimeout).toHaveBeenCalledTimes(1);
            s.timers[0]();

            expect(prefetch).toHaveBeenCalledWith("/admin/users", { data: false });
            expect(prefetch).toHaveBeenCalledWith("/admin/users/9", { data: false });
        });

        it("prefetches their data too when asked to", async () => {
            const s = boot();
            const router = (await start(s, { prefetch: { idle: ["/admin/users"], data: true } }))!;
            const prefetch = vi.spyOn(router, "prefetch").mockImplementation(() => undefined);
            s.timers[0]();
            expect(prefetch).toHaveBeenCalledWith("/admin/users", { data: true });
        });

        it("does nothing when there's nothing listed, or when the user asked to save data", async () => {
            const none = boot();
            await start(none, { prefetch: {} });
            await start(boot(), {});
            expect(none.win.setTimeout).not.toHaveBeenCalled();

            const saving = boot({ win: { navigator: { connection: { saveData: true } } } });
            await start(saving, { prefetch: { idle: ["/admin/users"] } });
            expect(saving.win.setTimeout).not.toHaveBeenCalled();
        });
    });

    describe("options", () => {
        it("gives the router the app's effects, which settle uses", async () => {
            const s = boot();
            const router = (await start(s, { effects: { focus: "#main", scroll: "preserve" } }))!;
            expect(router.effects()).toEqual({ focus: "#main", scroll: "preserve" });
        });

        it("marks the root while a navigation is under way, if asked to", async () => {
            const s = boot();
            const router = (await start(s, { pendingAttributes: true }))!;
            s.win.fetch.mockReturnValue(new Promise(() => undefined));

            void router.navigate("/admin/users/9");

            expect(s.container.setAttribute).toHaveBeenCalledWith("aria-busy", "true");
            expect(router.isPending()).toBe(true);
        });

        it("leaves the browser's scroll restoration, and the saved position, to the browser when scroll is false", async () => {
            const s = boot();
            s.win.history.state = { rrScroll: { x: 3, y: 400 } };
            await start(s, { effects: { scroll: false } });
            expect(s.win.history.scrollRestoration).toBe("auto");
            expect(s.win.scrollTo).not.toHaveBeenCalled();
        });
    });
});
