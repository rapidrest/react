///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { vi } from "vitest";
import {
    Link,
    linkHandlers,
    RouterApi,
    RouterLocation,
    RouterProvider,
    useParams,
    usePathname,
    useRouter,
} from "../src/routerContext.js";

const LOCATION: RouterLocation = { pathname: "/admin/users/7", search: "?tab=1", params: { id: "7" }, route: "/users/:id" };

function fakeApi(over: Partial<RouterApi> = {}): RouterApi {
    return {
        navigate: vi.fn(async () => true),
        prefetch: vi.fn(),
        canHandle: vi.fn(() => true),
        ...over,
    };
}

/** Renders `element` on the server, and hands back what the component (called during that render) returned. */
function renderAndCapture<T>(fn: () => T, provider?: { location: RouterLocation; api?: RouterApi | null }): { html: string; value: T } {
    let value!: T;
    const Capture = () => {
        value = fn();
        return null;
    };
    const tree: ReactElement = provider ? createElement(RouterProvider, provider, createElement(Capture)) : createElement(Capture);
    const html = renderToString(tree);
    return { html, value };
}

const click = (over: Record<string, any> = {}) => ({
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    currentTarget: { getAttribute: (n: string) => (n === "href" ? "/x" : null), hasAttribute: () => false },
    ...over,
});

describe("hooks", () => {
    it("report where the page is, and the router's ways of going elsewhere", () => {
        const api = fakeApi();
        const { value } = renderAndCapture(() => useRouter(), { location: LOCATION, api });

        expect(value).toMatchObject(LOCATION);
        expect(value.navigate).toBe(api.navigate);
        expect(value.prefetch).toBe(api.prefetch);
        expect(value.canHandle).toBe(api.canHandle);
    });

    it("give the path and the params directly", () => {
        expect(renderAndCapture(() => usePathname(), { location: LOCATION }).value).toBe("/admin/users/7");
        expect(renderAndCapture(() => useParams(), { location: LOCATION }).value).toEqual({ id: "7" });
    });

    it("on the server there's a location but no router, so all that's left is leaving the page the ordinary way", async () => {
        const { value } = renderAndCapture(() => useRouter(), { location: LOCATION, api: null });

        expect(value.pathname).toBe("/admin/users/7");
        expect(value.canHandle("/x")).toBe(false);
        expect(() => value.prefetch("/x")).not.toThrow();
        // There's no `window` here (the server), so there's nowhere to go — and no crash.
        expect(await value.navigate("/x")).toBe(false);
    });

    it("outside any provider, report nowhere in particular", () => {
        const { value } = renderAndCapture(() => useRouter());
        expect(value).toMatchObject({ pathname: "", search: "", params: {}, route: "" });
    });

    it("outside a provider in a browser, navigate() loads the page the ordinary way", async () => {
        const assign = vi.fn();
        (globalThis as any).window = { location: { assign } };
        try {
            const { value } = renderAndCapture(() => useRouter());
            expect(await value.navigate("/somewhere")).toBe(false);
            expect(assign).toHaveBeenCalledWith("/somewhere");
        } finally {
            delete (globalThis as any).window;
        }
    });

    it("the provider renders no markup of its own", () => {
        const html = renderToString(createElement(RouterProvider, { location: LOCATION }, createElement("p", null, "hi")));
        expect(html).toBe("<p>hi</p>");
    });
});

describe("linkHandlers", () => {
    const behavior = (api: RouterApi | null, over: Record<string, any> = {}) => ({ api, href: "/admin/users", prefetch: true, ...over });

    describe("onClick", () => {
        it("takes over a click on a link the router can handle", () => {
            const api = fakeApi();
            const event = click();

            linkHandlers(behavior(api, { replace: true, scroll: false }), {}).onClick(event as any);

            expect(event.preventDefault).toHaveBeenCalled();
            expect(api.canHandle).toHaveBeenCalledWith("/admin/users");
            expect(api.navigate).toHaveBeenCalledWith("/admin/users", { replace: true, scroll: false });
        });

        it("calls the link's own handler first, and leaves the click alone if that already handled it", () => {
            const api = fakeApi();
            const own = vi.fn((e: any) => {
                e.defaultPrevented = true;
            });
            const event = click();

            linkHandlers(behavior(api), { onClick: own }).onClick(event as any);

            expect(own).toHaveBeenCalledWith(event);
            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(api.navigate).not.toHaveBeenCalled();
        });

        it("leaves it to the browser when the router can't handle the destination", () => {
            const api = fakeApi({ canHandle: vi.fn(() => false) });
            const event = click();

            linkHandlers(behavior(api), {}).onClick(event as any);

            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(api.navigate).not.toHaveBeenCalled();
        });

        it("leaves it to the browser for a modified click", () => {
            const api = fakeApi();
            const event = click({ metaKey: true });

            linkHandlers(behavior(api), {}).onClick(event as any);

            expect(event.preventDefault).not.toHaveBeenCalled();
            expect(api.canHandle).not.toHaveBeenCalled();
        });

        it("leaves it to the browser when there's no router (the server, or a page with none)", () => {
            const event = click();
            linkHandlers(behavior(null), {}).onClick(event as any);
            expect(event.preventDefault).not.toHaveBeenCalled();
        });
    });

    describe("prefetching", () => {
        it("warms the page up when the link is pointed at or focused, after the link's own handlers", () => {
            const api = fakeApi();
            const order: string[] = [];
            const handlers = linkHandlers(behavior(api), {
                onMouseEnter: () => order.push("own-enter"),
                onFocus: () => order.push("own-focus"),
            });
            (api.prefetch as any).mockImplementation(() => order.push("prefetch"));

            handlers.onMouseEnter({} as any);
            handlers.onFocus({} as any);

            expect(order).toEqual(["own-enter", "prefetch", "own-focus", "prefetch"]);
            expect(api.prefetch).toHaveBeenCalledWith("/admin/users");
        });

        it("does nothing extra when turned off, when there's no router, or without handlers of its own", () => {
            const api = fakeApi();
            linkHandlers(behavior(api, { prefetch: false }), {}).onMouseEnter({} as any);
            linkHandlers(behavior(null), {}).onFocus({} as any);
            expect(api.prefetch).not.toHaveBeenCalled();
        });
    });
});

describe("Link", () => {
    it("renders as an ordinary link, on the server, with everything it's given", () => {
        const html = renderToString(
            createElement(
                RouterProvider,
                { location: LOCATION, api: null },
                createElement(Link, { href: "/admin/users", className: "nav", "aria-current": "page" }, "Users"),
            ),
        );
        expect(html).toBe('<a class="nav" aria-current="page" href="/admin/users">Users</a>');
    });

    it("renders the same with a router, and without any provider at all", () => {
        const withRouter = renderToString(
            createElement(RouterProvider, { location: LOCATION, api: fakeApi() }, createElement(Link, { href: "/a" }, "A")),
        );
        const bare = renderToString(createElement(Link, { href: "/a" }, "A"));
        expect(withRouter).toBe('<a href="/a">A</a>');
        expect(bare).toBe('<a href="/a">A</a>');
    });

    it("is wired to the router's handlers, with its own options", () => {
        const api = fakeApi();
        const { value } = renderAndCapture(() => Link({ href: "/admin/users", replace: true, prefetch: false, children: "Users" }), {
            location: LOCATION,
            api,
        });

        expect(value.type).toBe("a");
        expect(value.props.href).toBe("/admin/users");
        const event = click();
        (value.props as any).onClick(event);
        expect(api.navigate).toHaveBeenCalledWith("/admin/users", { replace: true, scroll: undefined });
        (value.props as any).onMouseEnter({});
        expect(api.prefetch).not.toHaveBeenCalled();
    });
});

describe("the shared context", () => {
    it("is one object however many copies of the module are loaded, so a provider from one copy reaches hooks from another", async () => {
        // The server renders a page inside ReactRoute's provider (this package's server build) while the page's own Link
        // and hooks come from the client build: two compiled copies of this module. If each made its own context, the
        // hooks would never see the provider, and the server would render what the browser then fails to hydrate.
        const first = RouterProvider({ location: LOCATION });

        vi.resetModules();
        const secondCopy = await import("../src/routerContext.js");
        const second = secondCopy.RouterProvider({ location: LOCATION });

        expect(secondCopy.RouterProvider).not.toBe(RouterProvider);
        expect(second.type).toBe(first.type);
    });
});
