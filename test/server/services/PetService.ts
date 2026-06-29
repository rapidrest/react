///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////

/**
 * Example service that simulates database access.
 * In a real app, inject a database client (e.g. TypeORM, Mongoose, ioredis)
 * via @Inject and query it here.
 */
export class PetService {
    async findAll(): Promise<string[]> {
        // Simulates: SELECT name FROM pets ORDER BY name
        return ["Parrot", "Rabbit"];
    }
}
