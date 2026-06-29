===============================================================================
Client API
===============================================================================

.. code-block:: typescript

   import { hydrateRoute, getHydrationProps } from "@rapidrest/react/client";

The ``@rapidrest/react/client`` entry point is a browser-only module that
provides helpers for client-side React hydration.  It should only be imported
in client bundle entry files — never in server-side code.


hydrateRoute
------------

.. code-block:: typescript

   function hydrateRoute(
       Component: ComponentType<any>,
       rootId?: string,
       propsId?: string
   ): void

Hydrates a server-rendered React page.

Reads serialised props from the DOM, then calls React's ``hydrateRoot`` on
the root container element.

**Parameters**

- ``Component`` — the same React component that was rendered on the server.
  Must match the ``default`` export of the corresponding page file.
- ``rootId`` *(optional, default ``"react-root"``)*  — the ``id`` of the
  ``<div>`` wrapping the hydration root, as set by ``ReactRoute.hydrateRootId``.
- ``propsId`` *(optional, default ``"react-props"``)*  — the ``id`` of the
  ``<script type="application/json">`` element, as set by
  ``ReactRoute.hydratePropsId``.

**Returns** ``void``.  Logs an error to the console if the container element
is not found; otherwise silently no-ops when called in a non-browser
environment (``typeof document === "undefined"``).

**Example**

.. code-block:: typescript

   // app/pets.entry.tsx  (Vite client entry — NOT the page file itself)
   import { hydrateRoute } from "@rapidrest/react/client";
   import PetsPage from "./pets.js";

   hydrateRoute(PetsPage);

When using ``createViteConfig`` from ``@rapidrest/react/vite``, entry files
are generated automatically — you do not need to write them by hand.


getHydrationProps
-----------------

.. code-block:: typescript

   function getHydrationProps(propsId?: string): any

Reads and parses the serialised props injected by ``ReactRoute`` into the
server-rendered HTML.

**Parameters**

- ``propsId`` *(optional, default ``"react-props"``)*  — the ``id`` of the
  ``<script type="application/json">`` element.

**Returns** The parsed props object, or ``undefined`` if the element is not
found, the environment is non-browser, or JSON parsing fails.

**Example**

.. code-block:: typescript

   import { getHydrationProps } from "@rapidrest/react/client";

   const props = getHydrationProps();
   console.log(props?.pets); // ["Cat", "Dog"]

This function is called internally by ``hydrateRoute``.  Use it directly only
when you need access to the props before mounting (e.g. for analytics or A/B
testing).


Hydration Flow
--------------

The full server → client hydration flow:

1. **Server** renders the page with ``ReactRoute`` (``hydrate = true``):

   .. code-block:: html

      <html>
        <head>
          <link rel="stylesheet" href="/assets/pets-Xyz456.css">
        </head>
        <body>
          <div id="react-root"><!-- SSR output --></div>
          <script type="application/json" id="react-props">{"pets":["Cat","Dog"]}</script>
          <script type="module" src="/assets/pets-Abc123.js"></script>
        </body>
      </html>

2. **Browser** loads the page, parses the HTML.

3. **Client bundle** (``/assets/pets-Abc123.js``) executes, calling:

   .. code-block:: javascript

      hydrateRoute(PetsPage);

4. ``hydrateRoute`` reads the ``react-props`` element, parses the JSON, and
   calls:

   .. code-block:: javascript

      hydrateRoot(
          document.getElementById("react-root"),
          React.createElement(PetsPage, props)
      );

5. React reconciles the server-rendered DOM with the client tree.  No
   additional network requests are made for the initial render.


TypeScript Configuration for Client Code
-----------------------------------------

Client entry files must be compiled with browser-targeting settings.  Use the
provided base config:

.. code-block:: json

   // tsconfig.client.json
   {
       "extends": "@rapidrest/react/tsconfig/client",
       "compilerOptions": {
           "outDir": "dist/client"
       },
       "include": ["app"]
   }

See :doc:`tsconfig` for details.
