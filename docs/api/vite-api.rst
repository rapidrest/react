===============================================================================
Vite Plugin API
===============================================================================

.. code-block:: typescript

   import { createViteConfig } from "@rapidrest/react/vite";

The ``@rapidrest/react/vite`` entry point exports a Vite config factory and
the underlying hydration plugin.  It is designed to be used in
``vite.config.ts`` in the downstream project.

Requires ``vite >= 5`` and ``@vitejs/plugin-react >= 4`` to be installed.


createViteConfig
----------------

.. code-block:: typescript

   async function createViteConfig(
       options?: RapidRestViteOptions
   ): Promise<UserConfig>

Creates a Vite configuration object suitable for building client-side
hydration bundles for a ``@rapidrest/react`` project.

**Parameters**

- ``options`` *(optional)* — see `RapidRestViteOptions`_ below.

**Returns** A Vite ``UserConfig`` object (from ``vite``'s ``defineConfig``).

**Example**

.. code-block:: typescript

   // vite.config.ts
   import { createViteConfig } from "@rapidrest/react/vite";
   export default createViteConfig({ appDir: "app" });

**Example with Tailwind CSS**

.. code-block:: typescript

   // vite.config.ts
   import { createViteConfig } from "@rapidrest/react/vite";
   import tailwindcss from "@tailwindcss/vite";

   export default createViteConfig({
       appDir: "app",
       plugins: [tailwindcss()],
   });


RapidRestViteOptions
--------------------

.. code-block:: typescript

   interface RapidRestViteOptions {
       appDir?: string;
       outDir?: string;
       plugins?: Plugin[];
   }

``appDir``
~~~~~~~~~~

- **Type** ``string``
- **Default** ``"app"``

Path to the app directory, relative to the project root.  Must match the
``react:appDir`` nconf key used by ``ReactRoute``.

``outDir``
~~~~~~~~~~

- **Type** ``string``
- **Default** ``"dist/public"``

Output directory for the production build.  RapidREST auto-serves static
files from the ``public/`` subdirectory of the configured base path, so this
should resolve to that directory at runtime.

``plugins``
~~~~~~~~~~~

- **Type** ``Plugin[]``
- **Default** ``[]``

Additional Vite plugins to include.  These are appended after the built-in
React plugin and the hydration plugin.


Page Entry Discovery
--------------------

``createViteConfig`` auto-discovers page entry points from ``appDir`` using
the following rules:

**Included:**

- ``app/*.tsx`` — top-level files, excluding those starting with ``_``
- ``app/<dir>/index.tsx`` — ``index.tsx`` files one level deep, excluding
  ``_*`` directories

**Excluded:**

- Any file or directory whose name starts with ``_`` (``_layout.tsx``,
  ``_404.tsx``, ``_styles/``, etc.)
- Non-``index.tsx`` files inside subdirectories (treated as sub-components)

For each discovered entry, a **virtual module** is generated that imports the
page component and calls ``hydrateRoute``:

.. code-block:: typescript

   // Virtual entry for app/pets.tsx
   import { hydrateRoute } from "@rapidrest/react/client";
   import Component from "/abs/path/to/app/pets.tsx";
   hydrateRoute(Component);

Virtual modules use Rollup's ``\0`` prefix convention.  Because they have no
real ``facadeModuleId``, Vite falls back to the rollup input key
(``"app/pets.tsx"``) as the manifest entry name.  This means
``ReactRoute``'s manifest lookup — which uses the page file path relative to
``process.cwd()`` — resolves correctly.


Generated Vite Config
---------------------

The config produced by ``createViteConfig({ appDir: "app" })`` is equivalent
to:

.. code-block:: typescript

   defineConfig({
       plugins: [
           react(),                         // @vitejs/plugin-react
           rapidRestHydrationPlugin("app"), // auto-generated entries
       ],
       build: {
           outDir: "dist/public",
           manifest: true,   // required for ReactRoute manifest lookup
           emptyOutDir: true,
       },
   });

The ``manifest: true`` flag tells Vite to write
``dist/public/.vite/manifest.json`` on each build.
