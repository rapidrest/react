// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import {
    type BlockerOptions,
    type RouterApi,
    RouterProvider,
    useBlocker,
    useNavigationEffects,
    useRouter,
} from "../src/routerContext.js";
import type { Blocker, EffectsSource, NavigationEffects } from "../src/routerCore.js";

/*
 * The hooks that do their work in effects — registering a blocker, registering navigation effects, following the router's
 * pending state — which only run in a browser, against a fake router that records what they registered.
 */

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const LOCATION = { pathname: "/x", search: "", params: {}, route: "/x" };

/** A router that keeps what's registered with it, and lets a test change whether a navigation is pending. */
function fakeRouter() {
    const blockers = new Set<Blocker>();
    const sources: EffectsSource[] = [];
    const listeners = new Set<() => void>();
    let pending = false;
    const api: RouterApi = {
        navigate: vi.fn(async () => true),
        prefetch: vi.fn(),
        canHandle: vi.fn(() => true),
        block: vi.fn((blocker: Blocker) => {
            blockers.add(blocker);
            return () => void blockers.delete(blocker);
        }),
        addEffects: vi.fn((source: EffectsSource) => {
            sources.push(source);
            return () => void sources.splice(sources.indexOf(source), 1);
        }),
        currentUrl: () => new URL("https://example.com/x"),
        isPending: () => pending,
        subscribePending: (listener: () => void) => {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
    };
    return {
        api,
        blockers,
        sources,
        setPending(value: boolean) {
            pending = value;
            listeners.forEach((listener) => listener());
        },
        listenerCount: () => listeners.size,
    };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

const render = (node: ReactNode) => act(async () => root.render(node));
const within = (api: RouterApi | null, node: ReactNode, onMounted?: () => void) =>
    h(RouterProvider, { location: LOCATION, api, onMounted }, node);

describe("useBlocker", () => {
    function Blocking({ when, message }: { when: boolean | (() => boolean); message?: string | BlockerOptions }) {
        useBlocker(when, message);
        return null;
    }

    it("registers a blocker with the router, once, which is in force while `when` is true", async () => {
        const router = fakeRouter();
        await render(within(router.api, h(Blocking, { when: true })));

        expect(router.blockers.size).toBe(1);
        const [blocker] = [...router.blockers];
        expect(blocker.active()).toBe(true);

        await render(within(router.api, h(Blocking, { when: false })));
        expect(router.api.block).toHaveBeenCalledTimes(1);
        expect(blocker.active()).toBe(false);
    });

    it("takes `when` as a function too, asked whenever the blocker is (not just when the page last rendered)", async () => {
        const router = fakeRouter();
        let dirty = false;
        await render(within(router.api, h(Blocking, { when: () => dirty })));
        const [blocker] = [...router.blockers];

        expect(blocker.active()).toBe(false);
        dirty = true;
        expect(blocker.active()).toBe(true);
    });

    it("asks with the message it was given, or with what the options say, as of the last render", async () => {
        const router = fakeRouter();
        await render(within(router.api, h(Blocking, { when: true })));
        const [blocker] = [...router.blockers];
        expect(blocker.message).toBeUndefined();
        expect(blocker.onBlock).toBeUndefined();

        await render(within(router.api, h(Blocking, { when: true, message: "Discard?" })));
        expect(blocker.message).toBe("Discard?");
        expect(blocker.onBlock).toBeUndefined();

        const onBlock = vi.fn(() => true);
        await render(within(router.api, h(Blocking, { when: true, message: { message: "Sure?", onBlock } })));
        expect(blocker.message).toBe("Sure?");
        expect(blocker.onBlock).toBe(onBlock);
        expect(blocker.onBlock?.({ to: "/y" })).toBe(true);
    });

    it("is removed when the component goes", async () => {
        const router = fakeRouter();
        await render(within(router.api, h(Blocking, { when: true })));
        expect(router.blockers.size).toBe(1);

        await render(within(router.api, null));

        expect(router.blockers.size).toBe(0);
    });

    it("does nothing without a router around it", async () => {
        await render(h(Blocking, { when: true }));
        expect(container.innerHTML).toBe("");
    });
});

describe("useNavigationEffects", () => {
    function Effects({ effects, children }: { effects: NavigationEffects; children?: ReactNode }) {
        useNavigationEffects(effects);
        return children as any;
    }

    it("registers what it's given, read as of the last render", async () => {
        const router = fakeRouter();
        await render(within(router.api, h(Effects, { effects: { focus: "#a" } })));
        expect(router.sources).toHaveLength(1);
        expect(router.sources[0].get()).toEqual({ focus: "#a" });

        await render(within(router.api, h(Effects, { effects: { focus: "#b" } })));
        expect(router.api.addEffects).toHaveBeenCalledTimes(1);
        expect(router.sources[0].get()).toEqual({ focus: "#b" });
    });

    it("puts a component in line where it first rendered: a shell before the page inside it, though the page's effect runs first", async () => {
        const router = fakeRouter();
        await render(within(router.api, h(Effects, { effects: { focus: "#shell" } }, h(Effects, { effects: { focus: "#page" } }))));

        // Registered child first (effects run child-first), but ordered parent first.
        expect(router.sources.map((source) => source.get().focus)).toEqual(["#page", "#shell"]);
        const [page, shell] = router.sources;
        expect(shell.slot).toBeLessThan(page.slot);
    });

    it("keeps its place when it renders again, and a component that mounts later is later in line", async () => {
        const router = fakeRouter();
        await render(within(router.api, h(Effects, { effects: {} })));
        const { slot } = router.sources[0];
        await render(within(router.api, h(Effects, { effects: {} })));
        expect(router.sources[0].slot).toBe(slot);

        await render(within(router.api, h(Effects, { effects: {} }, h(Effects, { effects: {} }))));
        expect(router.sources[1].slot).toBeGreaterThan(slot);
    });

    it("is removed when the component goes", async () => {
        const router = fakeRouter();
        await render(within(router.api, h(Effects, { effects: { focus: "#a" } })));
        await render(within(router.api, null));
        expect(router.sources).toHaveLength(0);
    });

    it("does nothing without a router around it", async () => {
        await render(h(Effects, { effects: { focus: "#a" } }));
        expect(container.innerHTML).toBe("");
    });
});

describe("useRouter().pending", () => {
    function Pending() {
        return h("p", null, String(useRouter().pending));
    }

    it("follows the router: on while a navigation is in flight, off after, re-rendering what asks", async () => {
        const router = fakeRouter();
        await render(within(router.api, h(Pending)));
        expect(container.textContent).toBe("false");
        expect(router.listenerCount()).toBe(1);

        await act(async () => router.setPending(true));
        expect(container.textContent).toBe("true");

        await act(async () => router.setPending(false));
        expect(container.textContent).toBe("false");
    });

    it("stops listening when the component goes", async () => {
        const router = fakeRouter();
        await render(within(router.api, h(Pending)));
        await render(within(router.api, null));
        expect(router.listenerCount()).toBe(0);
    });

    it("is never pending outside a router", async () => {
        await render(h(Pending));
        expect(container.textContent).toBe("false");
    });
});

describe("RouterProvider's onMounted", () => {
    it("is called once, in the browser, after what's under it has mounted, and not when it renders again", async () => {
        const onMounted = vi.fn();
        await render(within(null, h("p", null, "a"), onMounted));
        expect(onMounted).toHaveBeenCalledTimes(1);

        await render(within(null, h("p", null, "b"), onMounted));
        expect(onMounted).toHaveBeenCalledTimes(1);
    });

    it("is optional", async () => {
        await render(within(null, h("p", null, "a")));
        expect(container.textContent).toBe("a");
    });
});
