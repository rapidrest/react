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

- Convention-based routing from an `app/` directory (`app/pets.tsx` and `app/pets/index.tsx`
  both serve `GET /pets`)
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
