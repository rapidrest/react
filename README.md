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
  directly by the route at request time
- Serialized props are embedded in the page (XSS-safely escaped) and read back on the client via
  `hydrateRoute()` / `getHydrationProps()`

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
