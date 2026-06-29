===============================================================================
TypeScript Configuration
===============================================================================

``@rapidrest/react`` ships two base ``tsconfig`` files that downstream projects
should extend.  They are exported from the package so they can be referenced
without knowing the installation path.


tsconfig/server
---------------

.. code-block:: json

   // tsconfig.json  (server-side compilation)
   {
       "extends": "@rapidrest/react/tsconfig/server"
   }

Configures TypeScript for Node.js server-side compilation with:

- ``"module": "NodeNext"``
- ``"moduleResolution": "NodeNext"``
- ``"target": "ES2020"``
- ``"jsx": "react"``
- ``"experimentalDecorators": true``
- ``"emitDecoratorMetadata": true``

These settings are required for:

- ``node:`` module protocol imports (e.g. ``import fs from "node:fs"``).
- RapidREST DI decorators (``@Route``, ``@Inject``, ``@Config``, ``@Init``).
- JSX compilation for server-side React rendering.

**Recommended project tsconfig:**

.. code-block:: json

   {
       "extends": "@rapidrest/react/tsconfig/server",
       "compilerOptions": {
           "rootDir": ".",
           "outDir": "dist",
           "declarationDir": "dist/types"
       },
       "include": ["src", "app"],
       "exclude": []
   }

Include both ``src`` (server code) and ``app`` (page files) so that ``tsc``
compiles page files to ``dist/app/*.js`` for production use.


tsconfig/client
---------------

.. code-block:: json

   // tsconfig.client.json  (client-side compilation)
   {
       "extends": "@rapidrest/react/tsconfig/client"
   }

Configures TypeScript for browser/Vite client-side compilation with:

- ``"module": "ESNext"``
- ``"moduleResolution": "Bundler"``
- ``"target": "ES2020"``
- ``"jsx": "react-jsx"``

The ``"Bundler"`` module resolution strategy is required by Vite and allows
extensionless imports.  The ``"react-jsx"`` transform uses the automatic JSX
runtime (no ``import React`` needed in page files).

**Recommended client tsconfig:**

.. code-block:: json

   {
       "extends": "@rapidrest/react/tsconfig/client",
       "compilerOptions": {
           "rootDir": "app",
           "outDir": "dist/client"
       },
       "include": ["app"]
   }


Separate Server and Client Compilation
---------------------------------------

Because server and client code require incompatible ``module`` settings
(``NodeNext`` vs ``ESNext``), they must be compiled separately.

A typical project has three tsconfig files:

.. list-table::
   :header-rows: 1
   :widths: 30 70

   * - File
     - Purpose
   * - ``tsconfig.json``
     - Server build: extends ``@rapidrest/react/tsconfig/server``, output to
       ``dist/``
   * - ``tsconfig.client.json``
     - Client build (consumed by Vite): extends
       ``@rapidrest/react/tsconfig/client``
   * - ``tsconfig.eslint.json``
     - ESLint type-checking: extends server tsconfig, includes both ``src/``
       and ``app/``, sets ``"noEmit": true``

The ``rapidrest-react build`` command runs ``tsc -p tsconfig.json`` (server)
and then ``vite build`` (client, which uses ``tsconfig.client.json``
internally).


Decorator Support
-----------------

RapidREST decorators require both ``experimentalDecorators`` and
``emitDecoratorMetadata`` to be ``true``.  These are set in
``tsconfig/server``.

If you use a separate bundler (e.g. SWC via ``unplugin-swc``) for test
compilation, ensure ``legacyDecorator: true`` and ``decoratorMetadata: true``
are enabled in the SWC config:

.. code-block:: typescript

   // vitest.config.ts
   import swc from "unplugin-swc";

   export default defineConfig({
       plugins: [
           swc.vite({
               jsc: {
                   parser: { syntax: "typescript", decorators: true },
                   transform: { decoratorMetadata: true, legacyDecorator: true },
               },
           }),
       ],
   });
