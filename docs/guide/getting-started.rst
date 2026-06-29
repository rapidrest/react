===============================================================================
Getting Started
===============================================================================

Installation
------------

Add ``@rapidrest/react`` to your RapidREST project:

.. code-block:: bash

   yarn add @rapidrest/react

The library has required peer dependencies and optional ones for the dev toolchain:

.. list-table::
   :header-rows: 1
   :widths: 30 15 15 40

   * - Package
     - Required
     - Optional
     - Purpose
   * - ``@rapidrest/core``
     - ✓
     -
     - DI decorators, config, logging
   * - ``@rapidrest/service-core``
     - ✓
     -
     - HTTP server, routing
   * - ``react``
     - ✓
     -
     - React runtime
   * - ``react-dom``
     - ✓
     -
     - SSR and hydration
   * - ``vite``
     -
     - ✓
     - Client-bundle builds
   * - ``@vitejs/plugin-react``
     -
     - ✓
     - JSX transform for Vite
   * - ``tsx``
     -
     - ✓
     - TypeScript execution in dev
   * - ``nodemon``
     -
     - ✓
     - Server restarts in dev


Minimal Setup
-------------

**1. Create the app directory**

.. code-block:: text

   my-app/
   ├── app/
   │   ├── _layout.tsx        ← required: HTML wrapper
   │   └── index.tsx          ← route: GET /
   └── src/
       └── AppRouter.ts       ← route class

**2. Write the layout**

.. code-block:: typescript

   // app/_layout.tsx
   import React, { PropsWithChildren } from "react";

   export default function Layout({ children }: PropsWithChildren) {
       return (
           <html>
               <head><title>My App</title></head>
               <body>{children}</body>
           </html>
       );
   }

**3. Write a page**

.. code-block:: typescript

   // app/index.tsx
   import React from "react";

   export default function HomePage() {
       return <h1>Hello from RapidREST React!</h1>;
   }

**4. Register the route**

.. code-block:: typescript

   // src/AppRouter.ts
   import { RouteDecorators } from "@rapidrest/service-core";
   import { ReactRoute } from "@rapidrest/react";

   const { Route } = RouteDecorators;

   @Route("/app/*")
   export class AppRouter extends ReactRoute {}

**5. Configure nconf**

.. code-block:: typescript

   // src/config.ts (or wherever you build your nconf config)
   {
       react: {
           appDir: "app",
       }
   }

.. note::

   Use ``react:appDir`` (colon separator) when reading via ``nconf.get()``.
   nconf uses ``:`` as its hierarchy separator, not ``.``.

**6. Start the server**

.. code-block:: bash

   # Development (requires tsx and vite installed)
   npx rapidrest-react dev

   # Production
   npx rapidrest-react build
   node dist/server.js

The page at ``app/index.tsx`` will be served at ``/app/``.


Route Prefix
------------

The ``@Route("/app/*")`` prefix is recommended because RapidREST registers
static-file handlers with ``/*`` after user routes, and a named prefix takes
priority over ``/*`` regardless of registration order.

``ReactRoute`` automatically detects its own route prefix from the ``@Route``
metadata at startup and strips it before resolving page files. A request for
``GET /app/pets`` resolves to ``app/pets.tsx``, not ``app/app/pets.tsx``.

See :doc:`react-route` for configuration options.
