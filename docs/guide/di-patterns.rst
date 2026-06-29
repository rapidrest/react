===============================================================================
Dependency Injection Patterns
===============================================================================

``ReactRoute`` integrates with RapidREST's built-in dependency injection
system so that server-side services (database clients, caches, external APIs)
can be injected into the route class and used inside ``fetchProps``.


How DI Works in RapidREST
--------------------------

RapidREST's ``ClassLoader`` scans the server directory recursively when the
server starts, importing every exported class.  Each class is registered in
the ``ObjectFactory`` under a fully-qualified name derived from its path:

.. code-block:: text

   test/server/services/PetService.ts  →  fqn: "services.PetService"

Because *all* exported classes are registered — not only route classes — plain
service classes placed anywhere under the server directory are automatically
available for injection.  No explicit registration step is required.

The ``@Inject`` decorator, imported from ``@rapidrest/core``, requests an
instance of the named class at instantiation time:

.. code-block:: typescript

   import { ObjectDecorators } from "@rapidrest/core";
   const { Inject } = ObjectDecorators;

   @Inject(PetService) private petService: PetService;


Step-by-Step Example
---------------------

The following example shows a service that simulates database access and a
route that uses it to populate a page.

**1. Write the service**

.. code-block:: typescript

   // src/services/PetService.ts
   export class PetService {
       async findAll(): Promise<string[]> {
           // In a real app: return this.db.query("SELECT name FROM pets");
           return ["Parrot", "Rabbit"];
       }
   }

The service is a plain class with no decorators.  Place it anywhere under the
server source directory so ``ClassLoader`` discovers it.

**2. Inject the service into the route**

.. code-block:: typescript

   // src/AppRouter.ts
   import { HttpRequest, RouteDecorators } from "@rapidrest/service-core";
   import { ObjectDecorators } from "@rapidrest/core";
   import { ReactRoute } from "@rapidrest/react";
   import { PetService } from "./services/PetService.js";

   const { Route } = RouteDecorators;
   const { Inject } = ObjectDecorators;

   @Route("/app/*")
   export class AppRouter extends ReactRoute {
       @Inject(PetService) private petService: PetService;

       protected override async fetchProps(req: HttpRequest): Promise<any> {
           if (req.path.endsWith("/di-pets")) {
               return { pets: await this.petService.findAll() };
           }
           return {};
       }
   }

``fetchProps`` is called for every request.  Returning ``{}`` for paths that
are not handled here ensures the page file's own ``fetchProps`` export remains
in effect for those routes.

**3. Write the page**

.. code-block:: typescript

   // app/di-pets.tsx
   import React from "react";

   interface Props {
       pets?: string[];
   }

   // No fetchProps export — all data comes from the DI override.
   export default function DiPetsPage({ pets = [] }: Props) {
       return (
           <ul>
               {pets.map((pet) => <li key={pet}>{pet}</li>)}
           </ul>
       );
   }

The page receives ``pets`` from the class-level ``fetchProps`` override and
renders it directly.


Props Merge Order
-----------------

When both sources provide data, the merge is:

.. code-block:: text

   props = { ...pageProps, ...classProps }

Class-level props spread **last**, so they take precedence.  This lets you:

- Override specific keys from a page's own ``fetchProps`` when the class has
  more authoritative data (e.g. data from a validated DB query rather than a
  client-supplied cache).
- Return ``{}`` from the class override to leave page-level props untouched.

The built-in base keys ``user`` and ``userUid`` are always set from
``req.user`` before either ``fetchProps`` runs, and can be overridden by
either source.


Injecting Database Clients
--------------------------

RapidREST's ``@rapidrest/service-core`` ships built-in database decorators.
Inject a MongoDB or Redis connection directly into a service:

.. code-block:: typescript

   import { DatabaseDecorators } from "@rapidrest/service-core";
   import { Collection } from "mongodb";

   const { MongoConnection } = DatabaseDecorators;

   export class PetService {
       @MongoConnection("pets")
       private collection: Collection<Pet>;

       async findAll(): Promise<Pet[]> {
           return this.collection.find().toArray();
       }
   }

Configure the connection in nconf under the ``databases`` key as described in
the ``@rapidrest/service-core`` documentation.


Injecting Configuration
-----------------------

Use ``@Config`` from ``@rapidrest/core`` to inject nconf values into a service:

.. code-block:: typescript

   import { ObjectDecorators } from "@rapidrest/core";
   const { Config } = ObjectDecorators;

   export class PetService {
       @Config("pets:maxResults", 100)
       private maxResults: number;

       async findAll(): Promise<Pet[]> {
           return db.find().limit(this.maxResults).toArray();
       }
   }
