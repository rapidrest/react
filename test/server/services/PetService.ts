///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import { HttpRequest } from "@rapidrest/service-core";
import { ReactService } from "../../../src/ReactDecorators";

/**
 * Example service that simulates database access.
 * In a real app, inject a database client (e.g. TypeORM, Mongoose, ioredis)
 * via @Inject and query it here.
 */
@ReactService("/app/di-pets")
export class PetService {
    public async fetchProps(req: HttpRequest): Promise<any> {
        return { pets: ["Parrot", "Rabbit"] };
    }
}
