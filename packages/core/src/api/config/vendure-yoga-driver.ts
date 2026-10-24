import { YogaDriver, YogaDriverConfig } from '@graphql-yoga/nestjs';
import { Injectable } from '@nestjs/common';
import type { GqlRequestStartHookContext } from '@nestjs/graphql';
import type { Express } from 'express';
import type { Plugin as YogaPlugin } from 'graphql-yoga';

import { APOLLO_SERVER_PLUGINS_READY } from './apollo-server-plugin-compat';
import { snapshotRequestHeaders } from './yoga-plugins/original-request-headers';

/**
 * The NestJS GraphQL driver used by Vendure: `@graphql-yoga/nestjs`'s `YogaDriver` plus a few
 * details which `@nestjs/apollo` (the driver Vendure used before) provided:
 *
 * 1. A snapshot of each request's headers is taken before Yoga sees the request, so that plugins
 *    can read the `content-type` the client actually sent (see {@link ORIGINAL_REQUEST_HEADERS}).
 * 2. Startup waits for the `serverWillStart` hooks of any Apollo Server plugins, and fails if one
 *    of them fails, as `ApolloServer.start()` did.
 * 3. The request lifecycle hooks registered through `@nestjs/graphql`'s `ResolverDecoratorHost`
 *    (`setOnRequestStartHook` / `setOnRequestEndHook`) are invoked for every operation.
 * 4. The Yoga instance is disposed when the Nest application shuts down, so that plugin
 *    `onDispose` hooks (and through them the `serverWillStop`/`drainServer` hooks of any Apollo
 *    Server plugins run via the compatibility layer) fire exactly once.
 */
@Injectable()
export class VendureYogaDriver extends YogaDriver<'express'> {
    override async start(options: YogaDriverConfig<'express'>) {
        const plugins = [...(options.plugins ?? []), this.createRequestLifecycleHooksPlugin()];
        await super.start({ ...options, plugins });
        await Promise.all(
            plugins
                .map(p => (p as Record<symbol, unknown> | undefined)?.[APOLLO_SERVER_PLUGINS_READY])
                .filter((ready): ready is () => Promise<void> => typeof ready === 'function')
                .map(ready => ready()),
        );
    }

    protected override registerExpress(options: YogaDriverConfig<'express'>) {
        return super.registerExpress(options, {
            preStartHook: (app: Express) => {
                app.use(options.path ?? '/graphql', (req, _res, next) => {
                    snapshotRequestHeaders(req);
                    next();
                });
            },
        });
    }

    override async stop() {
        await super.stop();
        await this.yoga?.dispose?.();
    }

    /**
     * Port of `@nestjs/apollo`'s `createRequestLifecycleHooksPlugin()`.
     */
    private createRequestLifecycleHooksPlugin(): YogaPlugin {
        const host = () => this.resolverDecoratorHost;
        const started = new WeakMap<object, { hookContext: GqlRequestStartHookContext; state: unknown }>();
        return {
            onParams({ params, context }) {
                const decoratorHost = host();
                if (!decoratorHost?.hasRequestHooks()) {
                    return;
                }
                const hookContext = {
                    query: params.query,
                    operationName: params.operationName,
                    variables: params.variables,
                    context,
                };
                started.set(context, {
                    hookContext,
                    state: decoratorHost.onRequestStart(hookContext),
                });
            },
            onExecutionResult({ result, context }) {
                const entry = started.get(context);
                const decoratorHost = host();
                if (!entry || !decoratorHost) {
                    return;
                }
                started.delete(context);
                const single = result && !(Symbol.asyncIterator in result) ? result : undefined;
                decoratorHost.onRequestEnd({
                    ...entry.hookContext,
                    errors: single?.errors,
                    state: entry.state,
                });
            },
        };
    }
}
