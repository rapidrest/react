///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
///////////////////////////////////////////////////////////////////////////////
import crypto from "crypto";
import { DatabaseDecorators, HttpRequest, HttpResponse, RouteDecorators } from "@rapidrest/service-core";
import { Redis } from "ioredis";
import React, { ComponentType, PropsWithChildren, ReactNode } from "react";
const { RedisConnection } = DatabaseDecorators;
const { Init, Logger } = ObjectDecorators;
const {
    ContentType,
    Get,
    Request,
    Response
} = RouteDecorators;
import { renderToString } from "react-dom/server";
import { ObjectDecorators } from "@rapidrest/core";

const _hashCache: Map<string, string> = new Map();

/**
 * Abstract base class for all HTTP routes that will be rendered with React.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ReactRoute {
    @RedisConnection("cache")
    protected cacheClient?: Redis;

    /** The number of seconds to store the rendered page HTML in the cache. */
    protected readonly cacheTTL: number = 60;

    /** The React layout component to wrap the content with. */
    protected abstract readonly layout: ComponentType<PropsWithChildren>;

    @Logger
    protected logger: any;

    @Init
    protected init() {
        if (!this.layout) {
            throw new Error("Did you forget to set a page layout?");
        }
    }

    /**
     * Computes a hash key for the given request used for cache storage/lookup.
     * @param req The request to compute a hash key for.
     */
    protected hashRequest(req: HttpRequest): string {
        const key: string = "static." + JSON.stringify({ path: req.path, params: req.params, userUid: req.user?.uid });
        let hash: string | undefined = _hashCache.get(key);
        if (!hash) {
            hash = crypto.createHash("md5").update(key).digest("hex");
            // Clear the hash cache if it grows too big to prevent runaway memory usage
            if (_hashCache.size >= 10000) {
                _hashCache.clear();
            }
            // Store the hashed query string for faster lookup next time
            _hashCache.set(key, hash);
        }
        return hash;
    }

    @Get()
    @ContentType("text/html")
    public async get(@Request req: HttpRequest, @Response res: HttpResponse) {
        let html: string | null = null;

        // Attempt to retrieve the pre-rendered page in the cache
        const hash: string = this.hashRequest(req);
        if (this.cacheClient) {
            html = await this.cacheClient.get(hash);
        }

        if (!html) {
            this.logger.debug(`Page not found in cache [hash=${hash}]. Rendering...`);
            const Layout = this.layout;
            const props = {
                user: req.user,
                userUid: req.user?.uid,
                ...await this.fetchProps(req)
            };
            const page = this.renderHTML(props);
            // Render the page
            html = renderToString(
                <Layout>
                    {page}
                </Layout>
            );

            // Store the rendered HTML in the cache so that future requests are served faster
            if (this.cacheClient && html) {
                void this.cacheClient.setex(hash, this.cacheTTL, html);
            }
        }

        return html;
    }

    /**
     * Returns the React component props to use when rendering the page. Override this function to perform async
     * retrieval of data.
     *
     * @param req The HTTP request object to reference when fetching props.
     */
    protected async fetchProps(req: HttpRequest): Promise<any> {
        return undefined;
    }

    /**
     * Returns the React component to render and return to the client.
     *
     * @param props The pre-fetched data or props to use during rendering.
     */
    protected abstract renderHTML(props?: any): ReactNode;
}
