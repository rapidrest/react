===============================================================================
ReactRoute API
===============================================================================

.. code-block:: typescript

   import { ReactRoute } from "@rapidrest/react";

``ReactRoute`` is a non-abstract base class that can be subclassed to mount
React pages at a URL prefix.  It is exported from the package root.


Class Definition
----------------

.. code-block:: typescript

   export class ReactRoute {
       // --- Configuration ---
       protected readonly cacheTTL: number;
       protected readonly hydrate: boolean;
       protected readonly hydrateRootId: string;
       protected readonly hydratePropsId: string;

       // --- DI-injected ---
       protected cacheClient?: Redis;
       protected logger: any;

       // --- Lifecycle ---
       protected init(): void;

       // --- HTTP handler ---
       public async get(req: HttpRequest, res: HttpResponse): Promise<string | HttpResponse>;

       // --- Override point ---
       protected async fetchProps(req: HttpRequest): Promise<any>;

       // --- Utility ---
       protected hashRequest(req: HttpRequest): string;
   }


Constructor
-----------

``ReactRoute`` has no public constructor parameters.  All configuration is
injected via ``@Config`` decorators at instantiation time.


Properties
----------

``cacheTTL``
~~~~~~~~~~~~

.. code-block:: typescript

   protected readonly cacheTTL: number = 60;

Redis cache TTL in seconds.  Only active when ``NODE_ENV=production`` and a
Redis connection named ``"cache"`` is configured.

Override in a subclass to change the TTL:

.. code-block:: typescript

   protected override readonly cacheTTL = 300; // 5 minutes

``hydrate``
~~~~~~~~~~~

.. code-block:: typescript

   protected readonly hydrate: boolean = false;

Enables client-side React hydration when ``true``.  Requires
``react:manifestPath`` to be configured in production.  When enabled:

- The page is wrapped in ``<div id="{hydrateRootId}">``.
- Props are serialised to ``<script type="application/json" id="{hydratePropsId}">``.
- The content-hashed client bundle ``<script>`` and any associated CSS
  ``<link>`` tags are injected from the Vite manifest.

``hydrateRootId``
~~~~~~~~~~~~~~~~~

.. code-block:: typescript

   protected readonly hydrateRootId: string = "react-root";

The ``id`` attribute of the ``<div>`` wrapping the hydration root.  Must match
the ``rootId`` argument passed to :func:`hydrateRoute` in the client entry.

``hydratePropsId``
~~~~~~~~~~~~~~~~~~

.. code-block:: typescript

   protected readonly hydratePropsId: string = "react-props";

The ``id`` attribute of the ``<script type="application/json">`` element
carrying serialised props.  Must match the ``propsId`` argument passed to
:func:`hydrateRoute` or :func:`getHydrationProps`.

``cacheClient``
~~~~~~~~~~~~~~~

.. code-block:: typescript

   @RedisConnection("cache")
   protected cacheClient?: Redis;

Injected by RapidREST's ``@RedisConnection`` decorator.  ``undefined`` when
no Redis connection named ``"cache"`` is configured.

``logger``
~~~~~~~~~~

.. code-block:: typescript

   @Logger
   protected logger: any;

Injected Winston logger instance, shared with the rest of the RapidREST
server.


Methods
-------

``get(req, res)``
~~~~~~~~~~~~~~~~~

.. code-block:: typescript

   @Get()
   @ContentType("text/html")
   public async get(
       @Request req: HttpRequest,
       @Response res: HttpResponse
   ): Promise<string | HttpResponse>

The main HTTP handler, registered automatically by the ``@Get()`` decorator.
Returns an HTML string for 200 responses, or the ``HttpResponse`` object for
non-200 responses (so the status code is preserved past the middleware
wrapper).

Do not override this method; override ``fetchProps`` instead.

``fetchProps(req)``
~~~~~~~~~~~~~~~~~~~

.. code-block:: typescript

   protected async fetchProps(_req: HttpRequest): Promise<any>

Returns additional props to merge into the page component props.  The default
implementation returns ``{}``.

Override in subclasses to provide DI-injected data.  Class-level props spread
**after** page-level props, so they take precedence on key collisions:

.. code-block:: text

   final props = { user, userUid, ...pageFetchProps(req), ...this.fetchProps(req) }

``hashRequest(req)``
~~~~~~~~~~~~~~~~~~~~

.. code-block:: typescript

   protected hashRequest(req: HttpRequest): string

Computes a stable MD5 cache key from the request path, query parameters, and
``req.user?.uid``.  Used as the Redis key for HTML caching.


Config Keys
-----------

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - nconf key
     - Default
     - Description
   * - ``react:appDir``
     - ``"app"``
     - Filesystem path to the app directory, relative to ``process.cwd()``.
   * - ``react:manifestPath``
     - ``""``
     - Path to ``manifest.json`` produced by ``vite build``.


Route Prefix Auto-Detection
----------------------------

At ``@Init`` time, ``ReactRoute`` reads the ``rrst:routePaths`` metadata set
by the ``@Route`` decorator and derives a prefix string:

.. code-block:: text

   @Route("/app/*")   →   _routePrefix = "/app"
   @Route("/ui/*")    →   _routePrefix = "/ui"
   @Route("/*")       →   _routePrefix = ""

The prefix is stripped from ``req.path`` before page file resolution, so page
files are always relative to ``react:appDir`` regardless of where the route is
mounted.

.. warning::

   Using ``@Route("/*")`` conflicts with RapidREST's built-in static-file
   handler, which is also registered at ``/*``.  uWebSockets.js uses
   last-registration-wins for duplicate wildcard patterns, and the static
   handler is registered after user routes, so it always wins.  Use a named
   prefix such as ``@Route("/app/*")`` instead.
