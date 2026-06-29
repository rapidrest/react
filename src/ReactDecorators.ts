/**
 * Indicates that the decorated class is a React route service.
 *
 * @param paths The base path(s) of the app routes to apply the service for.
 */
export function ReactService(paths: string | string[]) {
    return function (target: Function) {
        let routePaths: string[] = Reflect.getMetadata("rrst:reactServicePaths", target.prototype) || [];
        routePaths = routePaths.concat(Array.isArray(paths) ? paths : [paths]);
        Reflect.defineMetadata("rrst:reactServicePaths", routePaths, target.prototype);
    };
}
