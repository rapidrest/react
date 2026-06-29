===============================================================================
Development Mode
===============================================================================

In development (``NODE_ENV`` not set to ``"production"``), ``ReactRoute``
provides browser live-reload via a lightweight Server-Sent Events (SSE)
endpoint built into the same RapidREST process.  No separate Vite dev server
is required.


How Live Reload Works
---------------------

1. The browser opens a persistent SSE connection to
   ``<prefix>/__rapidrest__/reload`` (e.g. ``/app/__rapidrest__/reload``).
2. ``ReactRoute`` watches the Vite manifest file (``react:manifestPath``) with
   ``fs.watch``.  When ``vite build --watch`` finishes a rebuild and writes a
   new manifest, a ``"reload"`` event is emitted on the shared SSE bus.
3. Connected browsers receive the event and call ``window.location.reload()``.
4. When the server restarts (e.g. via ``nodemon``), the SSE connection drops.
   The injected script switches to polling ``fetch("/")`` every 800 ms until
   the server responds, then reloads.

This gives fast full-page refresh on any source change without requiring the
state-preserving HMR infrastructure of a Vite dev server.


Dev Script Injection
--------------------

In non-production mode, ``ReactRoute`` injects the following script into every
rendered page (inserted before ``</body>``, or ``</html>`` as a fallback):

.. code-block:: javascript

   (function() {
       var e = new EventSource('/app/__rapidrest__/reload');
       e.onmessage = function(m) {
           if (m.data === 'reload') location.reload();
       };
       e.onerror = function() {
           e.close();
           (function p() {
               fetch('/').then(function() { location.reload(); })
                         .catch(function() { setTimeout(p, 800); });
           })();
       };
   })();

The SSE URL is automatically scoped to the route prefix set by ``@Route``.
A route mounted at ``@Route("/app/*")`` uses ``/app/__rapidrest__/reload``.


Starting the Dev Server
-----------------------

Use the CLI for the recommended dev workflow:

.. code-block:: bash

   npx rapidrest-react dev

This runs two processes in parallel:

- **Server** (``nodemon --exec "tsx src/server.ts"`` or ``tsx --watch`` if
  nodemon is not installed) — restarts the Node process on any ``.ts``,
  ``.tsx``, or ``.json`` change in ``src/`` or ``app/``.
- **Client** (``vite build --watch``) — rebuilds client bundles on any
  ``app/`` change.

See :doc:`../api/cli-api` for all CLI options.


Manual Dev Workflow
-------------------

If you prefer to manage processes yourself:

.. code-block:: bash

   # Terminal 1 — server with TypeScript execution
   npx tsx --watch src/server.ts

   # Terminal 2 — Vite client bundle watcher (only needed if hydrate = true)
   npx vite build --watch

When ``hydrate = false`` (the default), there are no client bundles to build
and you only need the server process.


Manifest Watching
-----------------

``ReactRoute`` starts a ``fs.watch`` on ``react:manifestPath`` at startup (in
non-production mode).  If the manifest does not exist yet — because the first
Vite build hasn't run — the watcher is silently skipped.  Live-reload via
server-restart SSE connection drop still works in that case.

When the manifest file is updated (Vite rebuild complete), the watcher fires a
debounced reload event (150 ms delay) to avoid reloading mid-write.
