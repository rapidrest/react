===============================================================================
ReactRoute
===============================================================================

``ReactRoute`` is the base class for serving React pages from a RapidREST
server.  Subclass it and apply ``@Route`` to mount it at a URL prefix.

.. code-block:: typescript

   import { RouteDecorators } from "@rapidrest/service-core";
   import { ReactRoute } from "@rapidrest/react";

   const { Route } = RouteDecorators;

   @Route("/app/*")
   export class AppRouter extends ReactRoute {}


Configuration
-------------

``ReactRoute`` reads two keys from nconf using colon-separated paths:

.. list-table::
   :header-rows: 1
   :widths: 25 15 60

   * - nconf key
     - Default
     - Description
   * - ``react:appDir``
     - ``"app"``
     - Filesystem path to the app directory, relative to ``process.cwd()``.
   * - ``react:manifestPath``
     - ``""``
     - Path to the Vite ``manifest.json``.  Required when ``hydrate = true``
       in production.

Example nconf defaults:

.. code-block:: typescript

   conf.defaults({
       react: {
           appDir: "app",
           manifestPath: "dist/public/.vite/manifest.json",
       },
   });

.. warning::

   nconf uses ``:`` (colon) as its hierarchy separator, **not** ``.`` (dot).
   ``conf.get("react.appDir")`` returns ``undefined``.
   Use ``conf.get("react:appDir")``.


Protected Properties
--------------------

Subclasses can override these properties to change runtime behaviour:

``cacheTTL``
~~~~~~~~~~~~

.. code-block:: typescript

   protected readonly cacheTTL: number = 60;

Cache time-to-live in seconds for production Redis caching.  Only active
when ``NODE_ENV=production`` and a Redis connection named ``"cache"`` is
configured.

``hydrate``
~~~~~~~~~~~

.. code-block:: typescript

   protected readonly hydrate: boolean = false;

When ``true``, wraps each page in a hydration root ``<div>`` and injects
the client JavaScript bundle and serialised props into the HTML.
See :doc:`../api/react-route-api` for the full hydration flow.

``hydrateRootId``
~~~~~~~~~~~~~~~~~

.. code-block:: typescript

   protected readonly hydrateRootId: string = "react-root";

DOM element ``id`` for the React hydration root ``<div>``.

``hydratePropsId``
~~~~~~~~~~~~~~~~~~

.. code-block:: typescript

   protected readonly hydratePropsId: string = "react-props";

DOM element ``id`` for the ``<script type="application/json">`` tag that
carries the serialised props to the client.


Request Handling
----------------

For every ``GET`` request, ``ReactRoute``:

1. Strips the route prefix (e.g. ``/app``) from the request path.
2. Returns an SSE stream for the dev live-reload endpoint
   (``/__rapidrest__/reload``) in non-production mode.
3. Checks the Redis cache (production only).
4. Resolves the page file (see :doc:`app-convention`).
5. Calls page-level ``fetchProps`` (exported from the page file, if present).
6. Calls ``this.fetchProps(req)`` (class-level override, empty by default).
7. Merges props: ``{ ...pageProps, ...classProps }`` — class-level wins.
8. Renders ``<Layout><PageComponent {...props} /></Layout>`` with
   ``renderToString``.
9. Injects hydration assets when ``hydrate = true``.
10. Injects the dev live-reload ``<script>`` in non-production mode.
11. Returns the HTML string (or calls ``res.send()`` directly for non-200
    responses so the status code is preserved).


fetchProps
----------

Page-level ``fetchProps``
~~~~~~~~~~~~~~~~~~~~~~~~~

Export an async function named ``fetchProps`` from any page file to provide
server-side data:

.. code-block:: typescript

   // app/pets.tsx
   import { HttpRequest } from "@rapidrest/service-core";

   export async function fetchProps(req: HttpRequest) {
       const userId = req.user?.uid;
       return { pets: await db.query("SELECT * FROM pets WHERE owner = ?", [userId]) };
   }

The function receives the ``HttpRequest`` object (including ``req.user``
populated by the auth middleware, if configured).

Class-level ``fetchProps``
~~~~~~~~~~~~~~~~~~~~~~~~~~

Override ``fetchProps`` in a subclass to inject DI services.  The return
value is **deep-merged after** page-level props, so class-level values take
precedence over page-level values for matching keys:

.. code-block:: typescript

   @Route("/app/*")
   export class AppRouter extends ReactRoute {
       @Inject(PetService) private petService: PetService;

       protected override async fetchProps(req: HttpRequest): Promise<any> {
           // Only override for specific paths; return {} for others so their
           // own page-level fetchProps are not overridden.
           if (req.path.endsWith("/di-pets")) {
               return { pets: await this.petService.findAll() };
           }
           return {};
       }
   }

See :doc:`di-patterns` for a full walkthrough.


Non-200 Responses
-----------------

RapidREST's middleware wrapper normalises handler return values to HTTP 200
by default.  ``ReactRoute`` bypasses this for error pages by calling
``res.status(N).send(html)`` directly and returning the response object.
The middleware detects this and skips the status override.

This means:

- ``_404.tsx`` is served with ``HTTP 404 Not Found``.
- ``_500.tsx`` is served with ``HTTP 500 Internal Server Error``.
- Normal pages return ``HTTP 200 OK``.
