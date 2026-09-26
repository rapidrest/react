# RapidREST: React Library

[![CI](https://github.com/rapidrest/react/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/rapidrest/react/actions/workflows/build.yml)
[![Coverage Status](https://coveralls.io/repos/github/rapidrest/react/badge.svg?branch=main)](https://coveralls.io/github/rapidrest/react?branch=main)
[![npm version](https://img.shields.io/npm/v/@rapidrest/react)](https://www.npmjs.com/package/@rapidrest/react)

A file-based React page framework for [`@rapidrest/service-core`](https://www.npmjs.com/package/@rapidrest/service-core)
servers. Drop `.tsx` files into an `app/` directory and `@rapidrest/react` turns them into
server-rendered routes — with layouts, DI-powered data fetching, Redis-backed page caching, and
opt-in client-side hydration — all served from the same RapidREST process, no separate Node
front-end server required.

For complete documentation please visit [RapidREST.dev](https://rapidrest.dev).

## Features

**File-Based Page Routing**

- Convention-based routing from an `app/` directory: any non-`_`-prefixed `.tsx` file, at any
  depth, is a page (`app/pets.tsx` and `app/pets/index.tsx` both serve `GET /pets`); colocate a
  shared/helper component under an `_`-prefixed file or directory name to keep it from becoming
  its own route
- Dynamic route segments — `app/pets/[id].tsx` (or `app/pets/[id]/index.tsx`) serves
  `GET /pets/:id`, with the captured value available as `req.params.id`/`props.params.id`
- `app/_layout.tsx` — a single global HTML wrapper applied to every page
- `app/_shell.tsx` — (with the client router) an app frame that stays mounted between pages
- A page may export `title` to set the document's `<title>`
- Default error page rendering. (e.g. `app/_404.tsx`, `app/_500.tsx`)
- Mount the router at any prefix (`@Route("/app/*")`, `@Route("/*")`, etc.) — page resolution is
  prefix-agnostic

**Server-Side Rendering**

- Renders pages to HTML with `react-dom/server` on every request; no client JS is required unless
  hydration is explicitly enabled
- Three composable levels of props for server-side rendering. page → service → route: a page's own
  exported `fetchProps`, a DI `@ReactService` for that path, and a
  `fetchProps()` override on the route subclass

**Dependency Injection**

- Subclass `ReactRoute` and use `@Inject` to pull RapidREST services into `fetchProps()`
- `@ReactService(path)` binds a plain DI-managed class as the data source for one or more page
  paths, so page components stay framework-free

**Caching**

- Built-in full-page cache with a configurable TTL per route
- Render cache supports multi-instance deployments using a common Redis database

**Opt-In Client Hydration**

- Pages are SSR-only by default; set `hydrate = true` on a route to hydrate specific pages on the
  client with `react-dom/client`
- `createViteConfig()` auto-discovers page entry points from your `app/` directory and generates
  virtual hydration modules for each — no hand-written entry files
- Built JS/CSS bundles are resolved from Vite's manifest and injected automatically, and served
  directly by the route at request time. Stylesheets are imported for their effect
  (`import "./app.css"`); CSS Modules (`styles.card`) and imported images or fonts aren't supported in
  a server-rendered page, since the class names and URLs are the client build's to decide
- Serialized props are embedded in the page (XSS-safely escaped) and read back on the client via
  `hydrateRoute()` / `getHydrationProps()`

**Opt-In Client-Side Navigation**

- Set `router = true` on a route (and `router: true` in `createViteConfig()`) and clicks between an
  app's pages swap the page in place, with no document reload — every URL still server-rendered
- Built on the existing file routes and props levels: no separate route table, no router
  dependency; `Link`, `useRouter()`, `usePathname()` and `useParams()` from `@rapidrest/react/client`
- Falls back to a normal browser navigation whenever it can't be sure (unknown URL, redirect, error,
  modified click, failed load)
- A persistent app shell (`_shell.tsx`) that stays mounted while pages are swapped in inside it
  (a nav rail, an open compose window), shallow navigation that keeps a page's state when only the
  query changes (`useSearchParams()`), `pending` state, focus, scroll and screen-reader
  announcements after a navigation, idle prefetch that respects Save-Data, `NavLink` and
  `useMatch()`, a page's own `title`, and `useBlocker()` for unsaved changes

**Developer Experience**

- `rapidreact dev` — runs your server with live restarts (via `nodemon`, falling back to
  `tsx --watch`) alongside `vite build --watch` for the client bundle, in one command
- `rapidreact build` — compiles the server with `tsc` and bundles the client with `vite build`
  for production
- `rapidreact export` — crawls every app page and writes a plain HTML/CSS/JS static site to disk,
  deployable to any static host with no server required at request time
- Server-Sent Events live-reload: connected browsers automatically refresh after a dev rebuild —
  no browser extension or separate dev server needed
- Per-user field allow-listing (`userFields`) — control exactly which `req.user` fields (if any)
  are exposed to page props and the hydration payload

## Installation

### NPM

```
npm i @rapidrest/react
```

### Yarn

```
yarn add @rapidrest/react
```

## Quick Start

```
app/
  _layout.tsx    # global HTML wrapper (required)
  _404.tsx       # optional 404 page
  _500.tsx       # optional error page
  index.tsx      # GET /
  pets.tsx       # GET /pets
```

Mount the router by subclassing `ReactRoute`:

```tsx
// src/routes/AppRouter.ts
import { ReactRoute } from "@rapidrest/react";
import { RouteDecorators } from "@rapidrest/service-core";
const { Route } = RouteDecorators;

@Route("/*")
export class AppRouter extends ReactRoute {
    protected readonly appDir: string = "app";
}
```

A page component, with page-level data fetching:

```tsx
// app/pets.tsx
import React from "react";

export default function Pets({ pets }: { pets: Pet[] }) {
    return (
        <ul>
            {pets.map((pet) => <li key={pet.id}>{pet.name}</li>)}
        </ul>
    );
}

export async function fetchProps() {
    return { pets: await fetch("https://api.example.com/pets").then((r) => r.json()) };
}
```

Or fetch the same data through dependency injection with `@ReactService`, so pages stay
framework-free and services can use `@Inject` like any other RapidREST class:

```ts
// src/services/PetsService.ts
import { ReactService } from "@rapidrest/react";
import { RepoUtils } from "@rapidrest/service-core";
import { ObjectDecorators } from "@rapidrest/core";
import Pet from "../models/Pet.js";
const { Inject } = ObjectDecorators;

@ReactService("/pets")
export default class PetsService {
    @Inject(RepoUtils, { name: Pet.name, args: [Pet] })
    private petRepo?: RepoUtils<Pet>;

    public async fetchProps() {
        return { pets: await this.petRepo?.find({}) };
    }
}
```

### Dynamic Routes

A bracketed file or directory name captures a single URL segment as a string, matching the
`:name` convention used elsewhere in RapidREST (e.g. `CRUDRoute`'s `@Get("/:id")`):

```
app/
  pets/
    [id].tsx           # GET /pets/:id
    [id]/index.tsx      # same route — either form works, like the static index convention
    [id]/
      reviews/
        [reviewId].tsx  # GET /pets/:id/reviews/:reviewId
```

```tsx
// app/pets/[id].tsx
import React from "react";

export default function PetDetail({ params }: { params: { id: string } }) {
    return <h1>Pet #{params.id}</h1>;
}

export async function fetchProps(req) {
    return { pet: await fetch(`https://api.example.com/pets/${req.params.id}`).then((r) => r.json()) };
}
```

`@ReactService` paths may also contain `:name` tokens, so dynamic pages get the same DI-backed
data fetching as static ones:

```ts
@ReactService("/pets/:id")
export default class PetService {
    @Inject(RepoUtils, { name: Pet.name, args: [Pet] })
    private petRepo?: RepoUtils<Pet>;

    public async fetchProps(req) {
        return { pet: await this.petRepo?.findById(req.params.id) };
    }
}
```

A service belongs to the page whose route its path names — `/pets/:id` is `app/pets/[id].tsx` (the
token's name needn't match the bracket's) — not to whatever URL happens to match it, so a literal
`app/pets/featured.tsx` beside it has its own service or none. A service's path is the page's public
URL, mount prefix included: a route mounted at `/admin` serves the services under `/admin`.

A few rules keep this predictable:

- **Static beats dynamic.** `app/pets/featured.tsx` wins over `app/pets/[id].tsx` for the literal
  request `/pets/featured`.
- **No backtracking.** Once a literal directory is matched at a given level, a resolution failure
  further down that path fails outright — it never retries a sibling bracket at that level.
- **One dynamic segment per directory level.** Sibling brackets (`[id]` and `[slug]` in the same
  directory) are a misconfiguration; the lexicographically-smallest name wins and a warning is
  logged every time a request hits the ambiguity.
- **No catch-all or optional segments** (no `[...slug]`, no `[[id]]`) — matching the rest of
  RapidREST's routing, which only ever supports a single `:name` token per path segment.

Statically exporting a dynamic route requires one more piece — see
[Dynamic routes in a static export](#dynamic-routes-in-a-static-export).

### Client Hydration (optional)

Enable hydration on a route, and generate a matching Vite build:

```ts
export class AppRouter extends ReactRoute {
    protected readonly appDir: string = "app";
    protected readonly hydrate: boolean = true;
}
```

```ts
// vite.config.ts
import { createViteConfig } from "@rapidrest/react/vite";
export default createViteConfig({ appDir: "app" });
```

Point the route at the generated manifest via nconf (`react:manifestPath`, e.g.
`dist/public/.vite/manifest.json`) and it will inject the right `<script>`/`<link>` tags and
serve the built assets automatically.

### Multiple Apps (optional)

A project can run more than one React app side by side — e.g. a public `www` app at `/` and an
`admin` app at `/admin` — each its own `ReactRoute` subclass with its own `appDir`:

```ts
@Route("/")
export class WwwRoute extends ReactRoute {
    protected readonly appDir: string = "apps/www";
}

@Route("/admin")
export class AdminRoute extends ReactRoute {
    protected readonly appDir: string = "apps/admin";
}
```

`createViteConfig()` accepts `appDir` as an array to build every app's hydration entries into one
manifest:

```ts
// vite.config.ts
export default createViteConfig({ appDir: ["apps/www", "apps/admin"] });
```

### Client-Side Navigation (optional)

Turn an app into one that navigates without loading a new document for every click, while every URL
is still rendered on the server exactly as before. Set `router = true` on the route, and build the
client with the router:

```ts
export class AppRouter extends ReactRoute {
    protected readonly appDir: string = "app";
    protected readonly router: boolean = true; // implies hydrate
}
```

```ts
// vite.config.ts — `true` for every appDir, or list the ones to route (or pass an object, below)
export default createViteConfig({ appDir: "app", router: true });
```

The server still answers every URL with a full, server-rendered document (crawlers, first loads,
reloads, and browsers without JavaScript see no difference). The client just takes over from there:
the router hydrates the page it was served, and from then on a click on a same-app link fetches
that page's data from the server (the same URL, asked for as JSON), loads its module and
stylesheets, and swaps it into place. `_layout.tsx` is part of the server-rendered document and
stays as it is — only the page inside it changes — with one exception: the layout's `<title>` is
rendered by the server for each page's props and sent along with its data, so the tab's title
follows the page. Anything else the layout renders from page props (an active nav item, say) is
what the first page showed, so keep that in the page. Back/forward, scroll position, and stylesheets
(the ones a page brings are removed again when it is left) work as they do for a normal page load.

Use `Link` for internal links — it prefetches a page when it is hovered or focused — and the hooks
to read or change where the page is:

```tsx
import { Link, useParams, usePathname, useRouter } from "@rapidrest/react/client";

export default function Pet() {
    const { id } = useParams();       // values captured by the route's :params
    const pathname = usePathname();   // includes the mount prefix
    const router = useRouter();       // { pathname, search, hash, params, route, pending, navigate, prefetch, canHandle }
    return (
        <>
            <Link href="/pets">All pets</Link>
            <button onClick={() => router.navigate("/pets", { replace: true })}>Done</button>
        </>
    );
}
```

`Link` accepts `replace` (replace the history entry instead of adding one), `scroll={false}` (keep
the scroll position) and `prefetch={false}`. Plain `<a href>` links are picked up too, so existing
markup and server-rendered content need no changes; put `data-router-ignore` on a link to leave it
to the browser, or `data-router-replace` to replace the history entry.

**When the router steps aside.** Anything it can't be sure of is handed back to the browser as an
ordinary navigation, so the worst case is the behaviour you had without the router: links with a
modifier key, `target`, `download` or `rel="external"`, another origin or another app's prefix,
hash-only changes, URLs that match no page, a page that redirects, answers with an error status, or
whose module or data fails to load. Only the latest of overlapping navigations is applied. A page
that throws while rendering after a navigation is reloaded the ordinary way once (guarded so it
can't loop).

**Things to know**
- The router's first-load cost is one extra entry chunk shared by every page of the app; each page's
  own module is loaded when it's navigated to (and hinted with `modulepreload` in the served HTML).
- The JSON for a page comes from the same `fetchProps` levels as the server render, is cached with
  the same TTL as the HTML in production, and is sent with `Vary: X-Rapidrest-Navigation` so caches
  and CDNs keep it apart from the document.
- `createViteConfig()` still builds a hydration entry per page under the router. They aren't loaded;
  the manifest records tell the server which stylesheets and chunks each page needs.
- Two apps don't share a router: a link from one app's prefix to another is a full navigation.

Everything below is opt-in; an app that uses none of it behaves as described above.

### A persistent app shell (`_shell.tsx`)

Without a shell, every navigation replaces the whole page: whatever sat around it (a navigation
rail, a half-written message, an open dialog) is rendered again from scratch. A **shell** is the
client-side layout that doesn't get replaced. Put `_shell.tsx` next to `_layout.tsx` (the `_` keeps
it from being a page) and its default export is rendered inside the hydration root, around the
page, and stays mounted while the router swaps the pages in and out inside it:

```
app/
  _layout.tsx    # the HTML document: <html>, <head>, scripts (server-rendered, never re-rendered)
  _shell.tsx     # the app around the page: mounted once, kept mounted
  index.tsx
  calendar.tsx
```

```tsx
// app/_shell.tsx — a nav rail and a compose window whose state survives navigation
import { useState, type ReactNode } from "react";
import { NavLink, useRouter } from "@rapidrest/react/client";
import Compose from "./_components/Compose.js";

export default function Shell({ children, user }: { children: ReactNode; user?: string }) {
    const { pending } = useRouter();
    const [draft, setDraft] = useState<string | null>(null); // still here after a navigation
    return (
        <div className="app" aria-busy={pending || undefined}>
            <nav>
                <NavLink href="/" end>Mail</NavLink>
                <NavLink href="/calendar">Calendar</NavLink>
                <button onClick={() => setDraft("")}>Compose</button>
            </nav>
            <main id="content">{children}</main>
            {draft !== null && <Compose draft={draft} onChange={setDraft} onClose={() => setDraft(null)} />}
        </div>
    );
}
```

```tsx
// vite.config.ts — nothing to add: an app with a _shell.tsx has it built into its router entry
export default createViteConfig({ appDir: "app", router: true });
```

**The contract**

- **What it gets.** `{ children, ...props }`: `children` is the current page (already wrapped so that
  it can fail on its own), and the rest are *the current page's props*, exactly what that page
  renders with (`fetchProps`, the service, the route, `params`, `user`, ...). They **change on every
  navigation** — the shell is the same instance, receiving the next page's props — so anything in
  them that should outlive a page (the user, the branding) should come from the route-level
  `fetchProps()` that every page shares, and anything that must persist belongs in the shell's own
  state, not in a prop.
- **What it can read.** The router: `useRouter()` (`pathname`, `search`, `hash`, `params`, `route`,
  `pending`, `navigate()`), `NavLink`, `useSearchParams()` — all the hooks work in the shell,
  rendered on the server with the request's location and hydrated with the same.
- **One root.** The server renders `Shell(Page)` inside `#react-root` and the client hydrates that
  same tree as one root, so the first load is what it always was. The router entry imports the shell
  statically (it is part of the first paint), so its code and stylesheets are in the entry, not in a
  page's chunk. On a navigation the router re-renders the shell's `children`; only the page is a new
  instance (React `key`), never the shell.
- **Per app directory.** The shell belongs to the `appDir`, and every page in it is rendered inside
  it. A navigation to a URL outside the app (another `appDir`, another mount prefix, an unknown
  route) is a real page load, as ever; there is no per-page opt-out — use a second `appDir` for pages
  that shouldn't have it. Only `_shell.tsx` (or `_shell/index.tsx`) at the top of the `appDir` counts.
- **Only under the router.** It is used by a route with `router = true`. With `hydrate` alone there
  is nothing to keep mounted between pages, so it is ignored. The `_404` and `_500` pages are never
  inside it: they aren't hydrated, and they render inside the layout only.
- **Failures.** A page that throws while rendering in the browser is caught by a boundary *inside*
  the shell: the shell stays, the page's slot is empty, and the router asks the server to render the
  URL (guarded so it can't loop). A shell that throws is the failure of the whole document and gets
  the same recovery. On the server either one is a 500, as any page that throws.
- **Static export.** The export crawls the real server, so the exported HTML has the shell around
  the page, and the router entry hydrates it.
- **Dev.** Nothing new: `rapidreact dev` rebuilds the client and reloads the browser, so the
  shell's state is lost on a rebuild as any page's is. Adding or removing `_shell.tsx` needs the
  client build restarted, as adding a page does.

### Shallow navigation and search params

By default a navigation that stays on the same route (`/pets/1` to `/pets/2`, or `?tab=a` to
`?tab=b`) still fetches the page's props and remounts the page, as it did in 2.0. Marking it
*shallow* keeps the page instance — its state, its focus, its scroll position — and changes only the
location, which `useRouter()` (`search`, `hash`, `params`) and everything reading it follows:

```tsx
import { Link, useRouter, useSearchParams } from "@rapidrest/react/client";

export default function Inbox() {
    const [params, setParams] = useSearchParams();
    const folder = params.get("folder") ?? "inbox";
    return (
        <>
            <Link href="/?folder=sent" shallow>Sent</Link>
            <button onClick={() => setParams({ folder: "drafts" })}>Drafts</button>
            <button onClick={() => setParams((prev) => ({ ...Object.fromEntries(prev), unread: "1" }), { replace: true })}>
                Unread only
            </button>
            <MessageList folder={folder} />
        </>
    );
}
```

- `router.navigate(url, { shallow: true })` (or `{ remount: false }`), `<Link shallow>` and
  `<a data-router-shallow>`. Only when the destination is another URL *of the route on screen*;
  a different route is an ordinary navigation. The page's props are not fetched again unless
  `refetch: true`; its `params` prop follows the URL.
- `useSearchParams()` returns `[URLSearchParams, setSearchParams]`. The setter takes anything
  `URLSearchParams` takes, an object (arrays repeat the key, `undefined` leaves it out) or a function
  of the current query; `{ replace }` replaces the history entry; **it is shallow by default**
  (`{ shallow: false }` for an ordinary navigation), as its point is changing the query without
  losing the page's state. It keeps the path and the `#fragment`, and several updates in a row each
  build on the one before.
- `useRouter()` and `useLocation()` (`{ pathname, search, hash }`) report the fragment. The server is
  never sent one, so it renders as empty there and on the client's first (hydrating) render, and
  follows right after.
- Going back or forward over shallow navigations is shallow too. A `#fragment`-only navigation
  never remounts the page (as in 2.0) and now updates `hash`.
- A shallow navigation, and a `#fragment`, don't ask a blocker (below) anything: the page, and what's
  in it, is still there.
- `navigate(url, { replace: true })` replaces the entry on any navigation; `push` is the default.

### Pending state, focus, scroll and announcements

`useRouter().pending` is `true` while a navigation is in flight (its page and data loading, the old
page still on screen) — `false` on the server and after. To mark the root for CSS and assistive
technology as well, `startRouter` takes `pendingAttributes: true` (`createViteConfig({ router: {
pendingAttributes: true } })`): the root gets `data-router-pending` and `aria-busy="true"` for as
long.

After a navigation completes the router does what a page load would have done: it moves focus
(so a screen reader starts at the new page), scrolls (to the top, or to the URL's `#fragment`; back
and forward restore where the entry was), and — if asked — announces the page. All three are
configured by one object, `NavigationEffects`:

```ts
{
    focus?: string | (() => HTMLElement | null) | false;  // default: the router's root
    scroll?: "top" | "preserve" | false;                  // default: "top"
    announce?: ({ title, pathname }) => string | false;   // default: nothing
}
```

- **`focus`**: a CSS selector (or a function that finds the element) to move focus to; `false` to
  leave it. The element gets `tabindex="-1"` if it has none, so that it takes focus without becoming
  a tab stop; if nothing matches, the root is used. Moving focus is what tells a screen reader user
  the page changed, and keeps the next Tab press where the new page starts.
- **`scroll`**: `"top"` scrolls a new page to the top (or its `#fragment`); `"preserve"` leaves it
  where it is (fragments and back/forward restoring still work); `false` doesn't touch scrolling at
  all, for an app whose shell scrolls an element of its own.
- **`announce`**: text for a polite, visually hidden `role="status"` live region that the router
  adds to `document.body`, outside React's tree, once. Return the new page's title (already set by
  then) for a screen reader to say "Calendar" after the page has changed; return `false` to stay
  quiet. Only page navigations announce, not shallow ones or fragments.

Set them for the whole app in the shell, or for one page in the page, with a hook. Where both set the
same option the one that rendered later — the page — wins, and it stops applying when it unmounts:

```tsx
import { useNavigationEffects } from "@rapidrest/react/client";

export default function Shell({ children }) {
    useNavigationEffects({ focus: "#content", announce: ({ title }) => title });
    return <main id="content">{children}</main>;
}
```

The JSON-able ones can also be given to the build: `createViteConfig({ router: { focus: "#content",
scroll: "preserve" } })`, or to `startRouter(routes, { effects: {...} })` in a hand-written entry;
`scroll: false` given there also leaves the browser's own scroll restoration on.

### Prefetching

`Link` warms its page when pointed at or focused, as before. More is available:

- `router.prefetch(href, { data: false })` warms only the page's module (and, through it, its
  stylesheets), not its data — for apps whose pages get their props from elsewhere, or that don't want
  the server to work out props on a guess. The default warms both.
- **Idle prefetch**: `createViteConfig({ router: { prefetch: { idle: ["/", "/calendar"] } } })` (or
  `startRouter(routes, { prefetch: { idle: [...] } })`) warms those pages' code once the page has
  loaded and the browser is idle (`requestIdleCallback`, with a timer where there is none) — unless the
  user has asked to save data (`navigator.connection.saveData`) or is on a 2G-class connection.
  `prefetch.data: true` fetches their data too. `shouldSaveData()` and `whenIdle(callback)` are
  exported from `@rapidrest/react/client` for your own speculative work.
- **Plain links**: `prefetch: { links: true }` warms the page of any plain `<a href>` the router
  would take over when it is pointed at, pressed on or focused (a `Link` always does). It's opt-in,
  since it has the server compute the props of every link the pointer passes over;
  `data-router-prefetch="false"` (which `<Link prefetch={false}>` sets) leaves one out.

Every kind follows the same rules as `Link`: only one of the app's pages, never a route that only a
root-level `[slug]` page matches (another route may serve `/logout`, and it mustn't be fetched on
hover), expiry after 30 seconds and at most 32 entries.

### Active links

```tsx
import { NavLink, useMatch } from "@rapidrest/react/client";

<NavLink href="/settings" className={({ active }) => (active ? "nav on" : "nav")}>Settings</NavLink>
<NavLink href="/mail?folder=inbox" matchQuery activeClassName="on">Inbox</NavLink>
<NavLink href="/" end>Home</NavLink>

const inSettings = useMatch("/settings/*");   // { params: { "*": "profile" }, pathname } | null
const pet = useMatch("/pets/:id");             // { params: { id: "7" }, pathname: "/pets/7" } | null
```

A `NavLink` is a `Link` that, while it goes to where the page is, has `aria-current="page"` (assistive
technology reads that as "current page", and CSS can select on it) and `activeClassName`; a
`className` function receives `{ active }`. It matches the path or any page below it (`/settings` on
`/settings/profile`, whole segments only), `end` for exactly the path; `/` is only ever active on
itself. The query is ignored unless `matchQuery` (every query parameter of the link must be in the
page's); the fragment always is. It is worked out from the router's location, so the server renders
it and the browser hydrates it the same. Only a path is ever active, never a link to another site.
Plain `Link` is unchanged and never sets `aria-current`.

`useMatch(pattern, { end })` matches the current path (mount prefix included, as every path here is)
against literal segments, `:name` segments and a trailing `*`, and returns `{ params, pathname }` or
`null`; it needs the whole path unless `end: false`. `useRouter().route` is the current route's
template (`/pets/:id`).

### A page's own title

A page module may export `title` — a string, or a function of the page's props (the ones it renders
with) that returns one, synchronously or not:

```tsx
export const title = "Calendar";
// or
export function title({ pet }: { pet: Pet }) { return `${pet.name} — Pets`; }
```

It sets the document's `<title>` in the server's HTML — replacing the layout's `<title>` in the
`<head>` (keeping its attributes), or adding one if the layout has none — and is the `title` the
client's navigations set on the document, so the tab's title follows the page. **Precedence:** the
page's `title` export, then the `<title>` the layout renders for the page's props, then nothing (the
layout's own title stays as it is). It applies to every route, router or not; a page that exports
nothing behaves as before. A `title` that throws is an error of the page (a 500).

### Navigation blockers

```tsx
import { useBlocker } from "@rapidrest/react/client";

export default function Editor() {
    const [dirty, setDirty] = useState(false);
    useBlocker(dirty, "Discard your changes?");
    // or: useBlocker(() => form.isDirty(), { onBlock: ({ to }) => showDialog(to) })
    ...
}
```

While the blocker is in force (`when` is `true`, or returns `true`), leaving the page for another
one asks first: a `Link`, a plain link, `router.navigate()` and back/forward show
`window.confirm(message)` — or call `onBlock({ to })`, which may be async and resolves `true` to let
go — and the navigation is dropped if the answer is no (`navigate()` resolves `false`). Closing the
tab, reloading and following a link the router can't handle bring up the browser's own "leave site?"
prompt, which can't be given text. A back or forward the user refuses is undone: the router goes
back through history to the entry it left (or, if that entry's position isn't known, adds an entry for
the page still showing), so the address bar and the page agree. Shallow navigations and fragments
are not asked about. A blocker whose `onBlock` throws blocks. Several blockers are asked in turn.

### The router's options in one place

```ts
startRouter(routes, {
    shell,                          // the default export of _shell.tsx (the generated entry passes it)
    effects: { focus, scroll, announce },
    pendingAttributes: true,
    prefetch: { idle: ["/", "/calendar"], data: false, links: false },
});
```

`createViteConfig({ router })` takes `true`, an array of `appDir`s, or an object with `appDirs`
(default: all) and any of `focus` (a selector or `false`), `scroll`, `pendingAttributes` and
`prefetch` — everything that can be written down as JSON is built into each routed app's entry;
`shell` is found by itself, and `announce` is a function, so it goes through `useNavigationEffects()`.

## Static Export

Every static page under `app/` is file-enumerable, so a whole `@rapidrest/react` app can be
crawled once and exported as a plain static site: HTML, CSS and JS, deployable to any static host
(S3, Netlify, GitHub Pages, a CDN) with no server needed at request time. A
[dynamic route](#dynamic-routes) (`pets/[id].tsx`) is exported too, for every concrete instance the
app can enumerate — see "Dynamic routes" below.

Rather than reimplementing `ReactRoute`'s rendering logic, export boots your *real* server (real
DI, real config, real `@ReactService`s) and crawls it over real HTTP, so the exported output can
never diverge from what a live deployment actually serves.

Write a small export entry script — the static-export analog of your `src/server.ts` — using
`runStaticExport()`:

```ts
// src/export.ts
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
import { runStaticExport } from "@rapidrest/react";
import config from "./config.js";

const logger = Logger();
const objectFactory = new ObjectFactory(config, logger);

const result = await runStaticExport(
    { config, basePath: ".", logger, objectFactory },
    { appDir: "app", routePrefix: "/app", outDir: "dist/export" }
);
await objectFactory.destroy();

if (result.errors.length > 0) {
    console.error(`[export] Completed with ${result.errors.length} error(s).`);
    process.exit(1);
}
console.log(`[export] Wrote ${result.pages.length} page(s) to dist/export.`);
```

For a [multi-app project](#multiple-apps-optional), pass `apps` instead of `appDir`/`routePrefix`
— each app's own `routePrefix` also becomes its output subdirectory, so pages from different apps
can't collide in `dist/export`:

```ts
const result = await runStaticExport(
    { config, basePath: ".", logger, objectFactory },
    {
        outDir: "dist/export",
        apps: [
            { appDir: "apps/www", routePrefix: "" },
            { appDir: "apps/admin", routePrefix: "/admin" },
        ],
    }
);
// -> dist/export/index.html, dist/export/admin/index.html, ...
```

Then run:

```
rapidreact export
```

This builds the client bundle (`vite build`) and runs `src/export.ts` (or `src/export.tsx`) with
`tsx` under `NODE_ENV=production`, writing `dist/export/index.html`,
`dist/export/pets/index.html`, etc. (trailing-slash/`index.html` convention — works with any
static file server), plus `dist/export/404.html` for static-host fallback routing, and a copy of
`dist/public` (the built hydration assets) into the export root.

### Dynamic routes in a static export

A [dynamic route](#dynamic-routes) has no fixed set of URLs, so exporting it statically requires
telling the exporter which concrete instances exist. A page (and/or its matching `@ReactService`)
can export `getStaticPaths()` — an async function returning every param combination the route
should be exported for:

```tsx
// app/pets/[id].tsx
export async function getStaticPaths() {
    const pets = await fetch("https://api.example.com/pets").then((r) => r.json());
    return pets.map((pet) => ({ id: pet.id })); // -> /pets/1, /pets/2, ...
}
```

```ts
// src/services/PetService.ts — DI-backed enumeration, e.g. querying a database
@ReactService("/pets/:id")
export default class PetService {
    @Inject(RepoUtils, { name: Pet.name, args: [Pet] })
    private petRepo?: RepoUtils<Pet>;

    public async getStaticPaths() {
        return (await this.petRepo?.find({}))?.map((pet) => ({ id: pet.id })) ?? [];
    }
}
```

Either is optional, and both may be used together (their results are merged) — a nested dynamic
route (`pets/[id]/reviews/[reviewId].tsx`) needs its own `getStaticPaths()` returning the full set
of params for *that* route (`{ id, reviewId }`), independent of its parent's. `getStaticPaths()`
only ever runs during `rapidreact export`/`runStaticExport()` — the endpoint it's served through is
inactive in a normal deployment (see `StaticExportResult.dynamicRoutes` below for what happens
when it isn't defined at all).

**Known limitations:**

- Hydration asset URLs are always root-absolute, so the exported site only works correctly when
  served from `/` — the same pre-existing constraint `hydrate` already has in a live deployment.
- Props are frozen at export time (like Next.js's static export): pages whose `fetchProps`/
  `@ReactService` depend on per-request or authenticated state will bake in whatever an
  unauthenticated crawl request renders. Use `exclude` to skip personalized pages entirely.
- A [dynamic route](#dynamic-routes) (`pets/[id].tsx`) with no `getStaticPaths()` anywhere (page
  or matching `@ReactService`) can't be enumerated, so it isn't crawled — it's reported via
  `result.dynamicRoutes` as its template (`/pets/:id`) instead. Supply concrete instances via
  `paths`/`StaticExportApp.paths` (e.g. `paths: ["/pets/1", "/pets/2"]`) to include it anyway, or
  `exclude` it entirely if it shouldn't be statically baked at all — an excluded route (whether
  enumerable or not) never appears in `dynamicRoutes` either, since it was deliberately opted out.

## Requirements

This package targets Node.js `>=24.0.0` and is published as an ESM-only package.

It declares `@rapidrest/core`, `@rapidrest/service-core`, `react` and `react-dom` as required peer
dependencies. The remaining peer dependencies are optional and only need to be installed if you
use the corresponding feature:

| Peer dependency        | Required for                                          |
| ----------------------- | ------------------------------------------------------ |
| `@rapidrest/core`       | Always                                                 |
| `@rapidrest/service-core` | Always                                                |
| `react`                 | Always                                                 |
| `react-dom`             | Always                                                 |
| `vite`                  | Client hydration builds (`createViteConfig`, `rapidreact build`/`dev`) |
| `@vitejs/plugin-react`  | Client hydration builds                                |
| `tsx`                   | `rapidreact dev` server watcher (used directly, or via `nodemon --exec`) |
| `nodemon`               | `rapidreact dev` — preferred server watcher when installed |

## License

MPL v2.0 — see [LICENSE](./LICENSE).
