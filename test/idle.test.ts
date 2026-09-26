///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { vi } from "vitest";
import { IDLE_FALLBACK_DELAY_MS, IDLE_TIMEOUT_MS, shouldSaveData, whenIdle } from "../src/idle.js";

/** A window that keeps its `load` listeners, and hands out timers a test can run. */
function fakeWindow(over: Record<string, any> = {}) {
    const listeners: Array<() => void> = [];
    const win = {
        setTimeout: vi.fn(() => 7),
        clearTimeout: vi.fn(),
        addEventListener: vi.fn((_type: string, handler: () => void) => listeners.push(handler)),
        removeEventListener: vi.fn(),
        ...over,
    };
    return { win, load: () => listeners.forEach((listener) => listener()) };
}

describe("whenIdle", () => {
    describe("with requestIdleCallback", () => {
        const idleWindow = () =>
            fakeWindow({ requestIdleCallback: vi.fn(() => 42), cancelIdleCallback: vi.fn() });

        it("asks for an idle period, with a timeout, at once when the page has already loaded", () => {
            const { win } = idleWindow();
            const callback = vi.fn();

            whenIdle(callback, win, { readyState: "complete" });

            expect(win.requestIdleCallback).toHaveBeenCalledWith(callback, { timeout: IDLE_TIMEOUT_MS });
            expect(win.addEventListener).not.toHaveBeenCalled();
        });

        it("waits for the load event while the page is still loading", () => {
            const { win, load } = idleWindow();
            const callback = vi.fn();

            whenIdle(callback, win, { readyState: "loading" });
            expect(win.requestIdleCallback).not.toHaveBeenCalled();
            expect(win.addEventListener).toHaveBeenCalledWith("load", expect.any(Function), { once: true });

            load();
            expect(win.requestIdleCallback).toHaveBeenCalledWith(callback, { timeout: IDLE_TIMEOUT_MS });
        });

        it("cancels the idle callback when asked to", () => {
            const { win } = idleWindow();

            const cancel = whenIdle(vi.fn(), win, { readyState: "complete" });
            cancel();

            expect(win.cancelIdleCallback).toHaveBeenCalledWith(42);
            expect(win.removeEventListener).toHaveBeenCalledWith("load", expect.any(Function));
        });

        it("never schedules anything when cancelled before the page has loaded", () => {
            const { win, load } = idleWindow();

            const cancel = whenIdle(vi.fn(), win, { readyState: "loading" });
            cancel();
            // (The listener was removed with it, so a real browser never calls it; if it were called it would still be harmless to cancel.)
            expect(win.removeEventListener).toHaveBeenCalledWith("load", expect.any(Function));
            expect(win.cancelIdleCallback).not.toHaveBeenCalled();
            load();
        });

        it("copes with a cancelIdleCallback that isn't there", () => {
            const { win } = fakeWindow({ requestIdleCallback: vi.fn(() => 1) });
            expect(() => whenIdle(vi.fn(), win, { readyState: "complete" })()).not.toThrow();
        });
    });

    describe("without requestIdleCallback", () => {
        it("runs the callback shortly after the page has loaded", () => {
            const { win } = fakeWindow();
            const callback = vi.fn();

            whenIdle(callback, win, { readyState: "complete" });

            expect(win.setTimeout).toHaveBeenCalledWith(callback, IDLE_FALLBACK_DELAY_MS);
        });

        it("can be cancelled before it runs", () => {
            const { win } = fakeWindow();

            whenIdle(vi.fn(), win, { readyState: "complete" })();

            expect(win.clearTimeout).toHaveBeenCalledWith(7);
        });
    });

    it("uses the window and document it finds when given none", () => {
        const { win } = fakeWindow();
        (globalThis as any).window = win;
        (globalThis as any).document = { readyState: "complete" };
        try {
            whenIdle(vi.fn());
            expect(win.setTimeout).toHaveBeenCalledTimes(1);
        } finally {
            delete (globalThis as any).window;
            delete (globalThis as any).document;
        }
    });
});

describe("shouldSaveData", () => {
    it("is false when the browser reports nothing about the connection, or there's no navigator at all", () => {
        expect(shouldSaveData({})).toBe(false);
        expect(shouldSaveData({ connection: {} })).toBe(false);
        expect(shouldSaveData(undefined)).toBe(false);
    });

    it("is true when the user asked to save data", () => {
        expect(shouldSaveData({ connection: { saveData: true } })).toBe(true);
    });

    it("is true on a 2G-class connection, and false on a fast one", () => {
        expect(shouldSaveData({ connection: { effectiveType: "slow-2g" } })).toBe(true);
        expect(shouldSaveData({ connection: { effectiveType: "2g" } })).toBe(true);
        expect(shouldSaveData({ connection: { effectiveType: "4g", saveData: false } })).toBe(false);
    });

    it("is false where there is no global navigator at all", () => {
        vi.stubGlobal("navigator", undefined);
        try {
            expect(shouldSaveData()).toBe(false);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("reads the global navigator when given none", () => {
        vi.stubGlobal("navigator", { connection: { saveData: true } });
        try {
            expect(shouldSaveData()).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
