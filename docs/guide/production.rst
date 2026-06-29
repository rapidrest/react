===============================================================================
Production Mode
===============================================================================

When ``NODE_ENV=production``, ``ReactRoute`` switches to production behaviour:
no dev-reload script is injected, the Vite manifest is loaded once at startup,
and rendered HTML is cached in Redis when a cache client is available.


Building for Production
-----------------------

Use the CLI build command:

.. code-block:: bash

   npx rapidrest-react build

This runs two steps in sequence:

1. ``tsc -p tsconfig.json`` — compiles the server (including ``app/`` pages to
   ``dist/app/*.js``).
2. ``vite build`` — bundles client-side JavaScript and generates a manifest.

After a successful build, ``dist/`` contains:

.. code-block:: text

   dist/
   ├── lib/           ← compiled server source (ReactRoute, etc.)
   ├── app/           ← compiled page files (e.g. dist/app/pets.js)
   └── public/
       ├── assets/    ← content-hashed JS/CSS bundles
       └── .vite/
           └── manifest.json   ← entry → hashed filename map

Configure nconf ``react:manifestPath`` to point to ``manifest.json``:

.. code-block:: typescript

   conf.defaults({
       react: {
           appDir: "dist/app",
           manifestPath: "dist/public/.vite/manifest.json",
       },
   });

.. note::

   In production, ``resolveAppFile`` finds ``.js`` files (compiled by
   ``tsc``).  In development it finds ``.tsx`` files directly (executed by
   ``tsx``).  The fallback order is ``tsx`` → ``jsx`` → ``js``, so the same
   config works in both modes.


Redis Caching
-------------

``ReactRoute`` caches rendered HTML in Redis in production mode.  To enable
it, configure a Redis connection named ``"cache"`` in your server config and
ensure the ``@RedisConnection("cache")`` decorator resolves to a connected
client.

Configure the connection via nconf (see ``@rapidrest/service-core``
documentation for database connection configuration) and set the TTL via the
``cacheTTL`` property:

.. code-block:: typescript

   @Route("/app/*")
   export class AppRouter extends ReactRoute {
       // Cache pages for 5 minutes instead of the default 60 seconds.
       protected override readonly cacheTTL = 300;
   }

Cache keys are MD5 hashes of the request path, query parameters, and the
authenticated user's UID, so per-user pages are cached separately.

Non-200 responses (404, 500) are **never** cached.

When no Redis client is configured, ``ReactRoute`` skips caching silently and
renders on every request.


Client-Side Hydration
---------------------

Set ``hydrate = true`` on a route to enable client-side React hydration:

.. code-block:: typescript

   @Route("/app/*")
   export class AppRouter extends ReactRoute {
       protected override readonly hydrate = true;
   }

When hydration is enabled, ``ReactRoute``:

1. Wraps the page component in ``<div id="react-root">`` during SSR.
2. Serialises the props to ``<script type="application/json" id="react-props">``
   and injects it into the HTML.
3. Looks up the page's content-hashed bundle URL in the Vite manifest and
   injects ``<script type="module" src="/assets/pets-Abc123.js">``.
4. Injects any CSS files listed in the manifest entry.

The client bundle calls ``hydrateRoute(PageComponent)`` which reads the props
from the DOM and calls React's ``hydrateRoot``.

See :doc:`../api/client-api` for the client-side API.


Vite Manifest Integration
--------------------------

The manifest maps each page file path to its hashed bundle filename:

.. code-block:: json

   {
       "app/pets.tsx": {
           "file": "assets/pets-Abc123.js",
           "css": ["assets/pets-Xyz456.css"]
       }
   }

``ReactRoute`` uses the page's absolute filesystem path, made relative to
``process.cwd()`` with forward-slash normalisation, as the lookup key.  If the
key is not found, an error is thrown and the 500 page is rendered.

In production, the manifest is read once at ``@Init`` time and cached for the
lifetime of the process.  In development (when ``react:manifestPath`` is
configured), it is re-read from disk on every request so rebuilt bundles are
reflected immediately.


Running in Production
---------------------

.. code-block:: bash

   NODE_ENV=production node dist/server.js

Ensure the following are configured before starting:

- ``react:appDir`` pointing to the compiled app directory (e.g.
  ``"dist/app"``).
- ``react:manifestPath`` pointing to ``dist/public/.vite/manifest.json``
  (only required when ``hydrate = true``).
- Redis connection named ``"cache"`` if you want page caching.
- A static file route serving ``dist/public/`` so the browser can load the
  client bundles.
