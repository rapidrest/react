===============================================================================
CLI Reference
===============================================================================

``@rapidrest/react`` ships a CLI binary ``rapidrest-react`` for managing the
development and production build lifecycle.

.. code-block:: bash

   npx rapidrest-react <command> [options]

The binary is available as ``./node_modules/.bin/rapidrest-react`` after
installation, or globally if the package is installed with ``-g``.


Commands
--------

dev
~~~

.. code-block:: bash

   rapidrest-react dev [entry]

Starts the server in development mode with live reload.  Runs two processes
in parallel:

1. **Server watcher** — executes the server entry file and restarts it on
   source changes.

   - If ``nodemon`` is installed (optional peer dependency), uses:

     .. code-block:: bash

        nodemon --exec "tsx <entry>" --watch src --watch app --ext ts,tsx,json

   - Otherwise falls back to:

     .. code-block:: bash

        tsx --watch <entry>

2. **Client bundle watcher** — rebuilds client-side JavaScript on ``app/``
   changes:

   .. code-block:: bash

      vite build --watch

Both processes share the same terminal output (``stdio: "inherit"``).  Either
process exiting with a non-zero code shuts down the other.

**Arguments**

- ``entry`` *(optional)* — path to the server entry file (e.g.
  ``src/server.ts``).  When omitted, the CLI searches for the first existing
  file in:

  .. code-block:: text

     src/server.ts
     src/server.tsx
     src/index.ts
     src/index.tsx

  Throws an error if none of these exist.

**Examples**

.. code-block:: bash

   # Auto-detect entry
   rapidrest-react dev

   # Explicit entry
   rapidrest-react dev src/server.ts


build
~~~~~

.. code-block:: bash

   rapidrest-react build [tsconfig]

Builds the project for production by running two steps sequentially:

1. ``tsc -p <tsconfig>`` — compiles the server TypeScript.
2. ``vite build`` — produces content-hashed client bundles and
   ``manifest.json``.

If either step fails, the error is reported and the process exits with code 1.

**Arguments**

- ``tsconfig`` *(optional, default ``"tsconfig.json"``)*  — path to the
  TypeScript config for the server build.

**Examples**

.. code-block:: bash

   # Default tsconfig
   rapidrest-react build

   # Custom tsconfig
   rapidrest-react build tsconfig.server.json


Tool Resolution
---------------

The CLI resolves ``nodemon``, ``tsx``, ``tsc``, and ``vite`` from the local
``node_modules/.bin/`` directory before falling back to the system PATH.  This
ensures the project's pinned versions are used rather than globally-installed
ones.


Exit Codes
----------

.. list-table::
   :header-rows: 1
   :widths: 15 85

   * - Code
     - Meaning
   * - ``0``
     - All processes exited successfully.
   * - ``1``
     - An unknown command was given, a process failed, or the server entry
       could not be found.
   * - ``N``
     - A child process exited with code ``N``; the CLI propagates the code.


Signal Handling
---------------

In ``dev`` mode, ``SIGINT`` and ``SIGTERM`` are forwarded to all child
processes, ensuring clean shutdown when the terminal is closed or the process
is killed.
