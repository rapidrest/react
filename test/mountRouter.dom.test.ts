// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { act, createElement as h, useEffect, useState } from "react";
import { vi } from "vitest";
import { type MountRouterOptions, mountRouter } from "../src/router.js";
import { NavLink, useParams, useRouter } from "../src/routerContext.js";
import type { Router } from "../src/routerCore.js";

/*
 * mountRouter() against a real DOM (jsdom) and the real React reconciler: proves the part shell.dom.test.ts already
 * proves for startRouter() — that a click on a NavLink navigates, without a full page load, to a client-only mount too
 * — and that mounting itself needs nothing already in the DOM (the root div is genuinely empty, no hydration markup,
 * no #rapidrest-router config) and asks the caller for its first page's props instead of reading them out of a script.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mounts: Record<string, number> = {};
function countMount(name: string) {
    useEffect(() => {
        mounts[name] = (mounts[name] ?? 0) + 1;
    }, []);
}

function PageA(props: { label?: string }) {
    const router = useRouter();
    const [clicks, setClicks] = useState(0);
    countMount("A");
    return h(
        "section",
        { id: "page" },
        h("p", { id: "who" }, `A ${props.label ?? ""} ${router.pathname}`),
        h("button", { id: "clicks", onClick: () => setClicks((c) => c + 1) }, `clicks ${clicks}`),
        h(NavLink, { href: "/b", id: "link-b" }, "to B"),
    );
}

function PageItem(props: { label?: string }) {
    const params = useParams();
    countMount("Item");
    return h("section", { id: "page" }, h("p", { id: "who" }, `item ${params.id} ${props.label ?? ""}`));
}

function PageB(props: { label?: string }) {
    countMount("B");
    return h("section", { id: "page" }, h("p", { id: "who" }, `B ${props?.label ?? ""}`));
}

const loads = {
    a: vi.fn(async () => ({ default: PageA })),
    b: vi.fn(async () => ({ default: PageB })),
    item: vi.fn(async () => ({ default: PageItem })),
};
const routes = [
    { template: "/", load: loads.a },
    { template: "/b", load: loads.b },
    { template: "/items/:id", load: loads.item },
];

const listeners: Array<{ target: any; type: string; handler: any }> = [];

const respond = (payload: any) => ({
    ok: true,
    redirected: false,
    headers: { get: () => "application/json" },
    json: async () => payload,
});

/**
 * What an ordinary navigation (a click, `router.navigate()`) still legitimately asks a server for once mounted: the
 * Router class mountRouter() returns is the exact same one startRouter() does, and a navigation to another *route* goes
 * through the same `fetchPayload()` round trip either way — mountRouter() only replaces the one-time bootstrap read
 * (`resolveProps`, below) of the *first* page's props, not that ongoing, shared navigation logic.
 */
function serve(href: string) {
    const url = new URL(href);
    const item = /^\/items\/(\w+)$/.exec(url.pathname);
    const route = item ? "/items/:id" : url.pathname;
    const params = item ? { id: item[1] } : {};
    return respond({ route, props: { label: `served ${url.pathname}`, params }, css: [] });
}

function makeWin() {
    const on = (target: any) => (type: string, handler: any) => {
        listeners.push({ target, type, handler });
        target.addEventListener(type, handler);
    };
    return {
        location: { get href() { return window.location.href; }, assign: vi.fn(), reload: vi.fn() },
        history: window.history,
        scrollX: 0,
        scrollY: 0,
        scrollTo: vi.fn(),
        fetch: vi.fn(async (href: string) => serve(href)),
        confirm: vi.fn(() => true),
        setTimeout: (handler: () => void, ms: number) => window.setTimeout(handler, ms),
        clearTimeout: (handle: any) => window.clearTimeout(handle),
        addEventListener: on(window),
        removeEventListener: (type: string, handler: any) => window.removeEventListener(type, handler),
        sessionStorage: window.sessionStorage,
    };
}

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

const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
const text = (selector: string) => $(selector)?.textContent;

async function settled<T>(fn: () => T | Promise<T>): Promise<T> {
    let result!: T;
    await act(async () => {
        result = await fn();
    });
    return result;
}

async function mount(path = "/", options: Partial<MountRouterOptions> = {}): Promise<{ router: Router; win: any }> {
    window.history.pushState(null, "", path);
    // A genuinely empty root — not even an empty string of markup, let alone anything a hydration would expect.
    const root = document.createElement("div");
    root.id = "app-root";
    document.body.appendChild(root);
    const win = makeWin();
    const doc = makeDoc();
    let router: Router | undefined;
    await act(async () => {
        router = await mountRouter(
            routes,
            { rootId: "app-root", resolveProps: async (route, params) => ({ label: `[${route.template}]`, params }), ...options },
            win,
            doc,
        );
    });
    return { router: router!, win };
}

beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const key of Object.keys(mounts)) delete mounts[key];
});

afterEach(async () => {
    for (const { target, type, handler } of listeners.splice(0)) target.removeEventListener(type, handler);
    await act(async () => {
        document.body.innerHTML = "";
    });
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("mountRouter, in a real DOM", () => {
    it("mounts into a genuinely empty root, with no #rapidrest-router config and no server-rendered markup", async () => {
        const before = document.getElementById("app-root");
        expect(before).toBeNull();
        expect(document.getElementById("rapidrest-router")).toBeNull();

        const { win } = await mount("/");

        expect(text("#who")).toBe("A [/] /");
        expect(mounts).toEqual({ A: 1 });
        // The first page's props came from resolveProps, not a server round trip.
        expect(win.fetch).not.toHaveBeenCalled();
    });

    it("resolves the matched route's props through resolveProps, reaching the mounted component", async () => {
        await mount("/items/9");
        expect(text("#who")).toBe("item 9 [/items/:id]");
    });

    it("returns undefined, and mounts nothing, for a URL that matches none of the routes", async () => {
        const { router } = await mount("/nope");
        expect(router).toBeUndefined();
        expect($("#page")).toBeNull();
    });

    it("navigates on a click on a NavLink exactly as startRouter()'s own mount does, with no full page load", async () => {
        const { win } = await mount("/");
        await settled(() => $("#clicks").click());
        expect(text("#clicks")).toBe("clicks 1");

        await settled(() => $("#link-b").click());

        expect(text("#who")).toBe("B served /b");
        expect(window.location.pathname).toBe("/b");
        expect(mounts).toEqual({ A: 1, B: 1 });
        // A client-side navigation, not the browser loading the next page — and, for a route change, the same
        // fetchPayload() round trip startRouter()'s own navigations make, since it's the same Router either way.
        expect(win.location.assign).not.toHaveBeenCalled();
        expect(win.fetch).toHaveBeenCalledTimes(1);
    });

    it("navigates identically through the returned Router's own navigate(), same as a page mounted by startRouter() would", async () => {
        const { router } = await mount("/");

        expect(await settled(() => router.navigate("/items/3"))).toBe(true);

        expect(text("#who")).toBe("item 3 served /items/3");
        expect(window.location.pathname).toBe("/items/3");
    });
});
