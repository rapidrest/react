===============================================================================
App Directory Convention
===============================================================================

All React UI code lives in a single directory (default: ``app/``) at the
project root.  The directory is configured via nconf key ``react:appDir``.


Directory Layout
----------------

.. code-block:: text

   app/
   ├── _layout.tsx            ← global HTML wrapper (required)
   ├── _404.tsx               ← 404 error page (optional)
   ├── _500.tsx               ← 500 error page (optional)
   ├── _styles/               ← CSS and assets (excluded from routing)
   │   └── globals.css
   ├── index.tsx              ← route: GET /
   ├── pets.tsx               ← route: GET /pets
   └── auth/
       └── login/
           └── index.tsx      ← route: GET /auth/login


Special Files
-------------

``_layout.tsx``
~~~~~~~~~~~~~~~

The global HTML wrapper. Required. Rendered on every page request.

Must export a default React component that accepts ``children``:

.. code-block:: typescript

   // app/_layout.tsx
   import React, { PropsWithChildren } from "react";

   export default function Layout({ children }: PropsWithChildren) {
       return (
           <html>
               <head>
                   <meta charSet="utf-8" />
                   <title>My App</title>
               </head>
               <body>{children}</body>
           </html>
       );
   }

``_404.tsx``
~~~~~~~~~~~~

Optional custom 404 page. Rendered (with HTTP status 404) when a request
path has no matching page file.

.. code-block:: typescript

   // app/_404.tsx
   import React from "react";

   export default function NotFoundPage() {
       return <h1>Page not found</h1>;
   }

If ``_404.tsx`` is absent, a bare ``<h1>404 Not Found</h1>`` is returned.

``_500.tsx``
~~~~~~~~~~~~

Optional custom 500 page. Rendered (with HTTP status 500) when an unhandled
exception occurs during SSR.

.. code-block:: typescript

   // app/_500.tsx
   import React from "react";

   export default function ErrorPage({ error }: { error?: unknown }) {
       return <h1>Internal server error</h1>;
   }

The ``error`` prop receives the thrown value (may be an ``Error`` instance).
If ``_500.tsx`` is absent, a bare ``<h1>500 Internal Server Error</h1>`` is
returned.

Any file or directory whose name begins with ``_`` is excluded from routing
and is never served as a page.


Page Files
----------

Every other ``.tsx``, ``.jsx``, or ``.js`` file in ``app/`` is a potential
page. A page file exports:

- **``default``** — the React component to render (required).
- **``fetchProps``** — an async function that returns the initial props
  (optional; see :doc:`react-route`).

.. code-block:: typescript

   // app/pets.tsx
   import React from "react";
   import { HttpRequest } from "@rapidrest/service-core";

   interface Props {
       pets: string[];
   }

   export default function PetsPage({ pets }: Props) {
       return (
           <ul>
               {pets.map((p) => <li key={p}>{p}</li>)}
           </ul>
       );
   }

   export async function fetchProps(_req: HttpRequest): Promise<Props> {
       return { pets: ["Cat", "Dog"] };
   }


URL-to-File Resolution
----------------------

``ReactRoute`` resolves a request path to a file by trying the following
suffixes in order, stopping at the first match:

.. list-table::
   :header-rows: 1
   :widths: 20 40

   * - URL path
     - Files tried (in order)
   * - ``/pets``
     - ``app/pets.tsx``, ``app/pets/index.tsx``, ``app/pets.jsx``,
       ``app/pets/index.jsx``, ``app/pets.js``, ``app/pets/index.js``
   * - ``/``
     - ``app/index.tsx``, ``app/index.jsx``, ``app/index.js``
   * - ``/auth/login``
     - ``app/auth/login.tsx``, ``app/auth/login/index.tsx``, …

This means ``.tsx`` takes priority (for development with ``tsx``), and
``.js`` is the production fallback after ``tsc`` compilation.


Index Convention
~~~~~~~~~~~~~~~~

A file named ``index.tsx`` inside a subdirectory serves the path *without*
the ``index`` suffix:

.. code-block:: text

   app/auth/login/index.tsx  →  GET /auth/login
   app/auth/login.tsx        →  GET /auth/login   (also works)

Both forms resolve to the same URL. The ``index`` convention is preferred
for routes that will have multiple files in the same directory.


Sub-components
~~~~~~~~~~~~~~

Non-``index`` files inside subdirectories are **not** routed automatically.
They can be imported as sub-components without being exposed as pages:

.. code-block:: text

   app/pets/PetCard.tsx      ← NOT routed; import from pets/index.tsx
   app/pets/index.tsx        ← routed as GET /pets
