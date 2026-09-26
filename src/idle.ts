///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/*
 * Helpers for work that only ever makes later things faster — fetching a page's code before it's asked for — and so must
 * never compete with what the user is waiting for. Both take the browser objects they read as arguments (defaulting to
 * the real ones) so they can be exercised without a browser.
 */

/** How long an idle callback may be held back on a busy page before it runs anyway, in milliseconds. */
export const IDLE_TIMEOUT_MS = 3_000;

/** How long to wait, where the browser has no `requestIdleCallback` (Safari), before running the work, in milliseconds. */
export const IDLE_FALLBACK_DELAY_MS = 200;

/** What `whenIdle()` uses of `window`. */
export interface IdleWindow {
    requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
    setTimeout(handler: () => void, ms: number): any;
    clearTimeout(handle: any): void;
    addEventListener(type: "load", handler: () => void, options?: { once: boolean }): void;
    removeEventListener(type: "load", handler: () => void): void;
}

/** What `whenIdle()` uses of `document`. */
export interface IdleDocument {
    readyState: string;
}

/**
 * Runs `callback` once the page has finished loading (the window's `load` event, which waits for every script and image
 * the page asked for) and the browser has nothing better to do (`requestIdleCallback`), or shortly after the load where
 * there is no such thing. Returns a function that cancels it if it hasn't run yet.
 */
export function whenIdle(
    callback: () => void,
    win: IdleWindow = window,
    doc: IdleDocument = document,
): () => void {
    let cancelIdle: () => void = () => undefined;
    const schedule = () => {
        if (typeof win.requestIdleCallback === "function") {
            const handle = win.requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS });
            cancelIdle = () => win.cancelIdleCallback?.(handle);
        } else {
            const timer = win.setTimeout(callback, IDLE_FALLBACK_DELAY_MS);
            cancelIdle = () => win.clearTimeout(timer);
        }
    };
    if (doc.readyState === "complete") {
        schedule();
    } else {
        win.addEventListener("load", schedule, { once: true });
    }
    return () => {
        win.removeEventListener("load", schedule);
        cancelIdle();
    };
}

/** What `shouldSaveData()` reads of `navigator`: its `connection`, where the browser has one (Chromium) — the Network Information API is in no standard type. */
export type ConnectionNavigator = object;

/**
 * `true` when the user has asked the browser to save data (`Save-Data`), or is on a very slow connection (2G-class):
 * work that only speculates about what will be needed — prefetching ahead of any sign of intent — shouldn't run then.
 * `false` where the browser says nothing about the connection (Safari, Firefox), and where there's no `navigator`.
 */
export function shouldSaveData(
    nav: ConnectionNavigator | undefined = typeof navigator === "undefined" ? undefined : navigator,
): boolean {
    const connection = (nav as { connection?: { saveData?: boolean; effectiveType?: string } } | undefined)?.connection;
    return connection?.saveData === true || connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g";
}
