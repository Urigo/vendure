/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
// Apollo's optional plugins are loaded lazily (as ApolloServer.start() does), so that usage and
// schema reporting and their dependencies are only loaded when they are enabled.
/**
 * Apollo Server installs a few plugins implicitly in `ApolloServer.start()`, and `@nestjs/apollo`
 * adds one of its own. Code running on Vendure (resolvers calling `info.cacheControl.setCacheHint()`,
 * schemas using `@cacheControl`, deployments relying on `APOLLO_KEY` usage reporting, clients
 * relying on Nest's status handling) depends on them, so they are installed here in the same way
 * and in the same order.
 */
import type { ApolloServerPlugin } from '@apollo/server';
import { createHash } from 'crypto';

import {
    ApolloLogger,
    ApolloServerPluginCompatOptions,
    ApolloServerPluginsCompat,
    createApolloServerPluginsCompat,
} from './use-apollo-server-plugins';

/**
 * The subset of Apollo's `ApolloConfig` which plugins read from `GraphQLServerContext.apollo`.
 */
export interface ApolloConfig {
    key?: string;
    keyHash?: string;
    graphRef?: string;
}

/**
 * Port of Apollo Server's `determineApolloConfig()`: reads `APOLLO_KEY`, `APOLLO_GRAPH_REF`,
 * `APOLLO_GRAPH_ID` and `APOLLO_GRAPH_VARIANT` from the environment.
 */
export function determineApolloConfig(env: NodeJS.ProcessEnv = process.env): ApolloConfig {
    const config: ApolloConfig = {};
    const key = env.APOLLO_KEY?.trim();
    if (key) {
        config.key = key;
        config.keyHash = createHash('sha512').update(key).digest('hex');
    }
    if (env.APOLLO_GRAPH_REF) {
        if (env.APOLLO_GRAPH_ID || env.APOLLO_GRAPH_VARIANT) {
            throw new Error(
                'Cannot specify both graph ref and graph ID or variant. Please use `APOLLO_GRAPH_REF` ' +
                    'without also setting the graph ID or variant.',
            );
        }
        config.graphRef = env.APOLLO_GRAPH_REF;
    } else if (env.APOLLO_GRAPH_ID) {
        config.graphRef = env.APOLLO_GRAPH_VARIANT
            ? `${env.APOLLO_GRAPH_ID}@${env.APOLLO_GRAPH_VARIANT}`
            : env.APOLLO_GRAPH_ID;
    }
    return config;
}

function internalId(plugin: ApolloServerPlugin<any>): string | undefined {
    return (plugin as any).__internal_plugin_id__;
}

/**
 * Returns the plugin list exactly as `ApolloServer.start()` would run it: the given plugins plus
 * Apollo's implicit ones (unless a plugin with the same internal id, including the `*Disabled`
 * variants, is already present):
 *
 * - `ApolloServerPluginCacheControl()`: always (gives resolvers `info.cacheControl` and sets the
 *   `Cache-Control` response header from `@cacheControl` hints).
 * - `ApolloServerPluginUsageReporting()`: when `APOLLO_KEY` and a graph ref are set.
 * - `ApolloServerPluginSchemaReporting()`: when `APOLLO_SCHEMA_REPORTING=true`.
 *
 * Landing-page plugins are not installed: Vendure serves GraphiQL itself. Apollo's inline-trace
 * plugin is not installed either, as it only runs for federated subgraphs.
 */
export function withApolloServerDefaultPlugins(
    plugins: Array<ApolloServerPlugin<any>>,
    options: { apollo: ApolloConfig; logger: ApolloLogger; env?: NodeJS.ProcessEnv },
): Array<ApolloServerPlugin<any>> {
    const env = options.env ?? process.env;
    const seen = new Map<string, { disabled: boolean; enabled: boolean }>();
    for (const plugin of plugins) {
        const id = internalId(plugin);
        if (!id) {
            continue;
        }
        const entry = seen.get(id) ?? { disabled: false, enabled: false };
        if ((plugin as any).__is_disabled_plugin__) {
            entry.disabled = true;
        } else {
            entry.enabled = true;
        }
        if (entry.disabled && entry.enabled) {
            throw new Error(
                `You have tried to install both ApolloServerPlugin${id} and ApolloServerPlugin${id}Disabled ` +
                    'in your server. Please choose whether or not you want to disable the feature and ' +
                    'install the appropriate plugin for your use case.',
            );
        }
        seen.set(id, entry);
    }
    const result = [...plugins];
    if (!seen.has('CacheControl')) {
        const { ApolloServerPluginCacheControl } = require('@apollo/server/plugin/cacheControl');
        result.push(ApolloServerPluginCacheControl());
    }
    if (!seen.has('UsageReporting') && options.apollo.key) {
        if (options.apollo.graphRef) {
            const { ApolloServerPluginUsageReporting } = require('@apollo/server/plugin/usageReporting');
            result.unshift(ApolloServerPluginUsageReporting({ __onlyIfSchemaIsNotSubgraph: true }));
        } else {
            options.logger.warn(
                'You have specified an Apollo key but have not specified a graph ref; usage reporting is ' +
                    'disabled. To enable usage reporting, set the `APOLLO_GRAPH_REF` environment variable to ' +
                    '`your-graph-id@your-graph-variant`. To disable this warning, install ' +
                    '`ApolloServerPluginUsageReportingDisabled`.',
            );
        }
    }
    if (!seen.has('SchemaReporting') && env.APOLLO_SCHEMA_REPORTING === 'true') {
        if (!options.apollo.key) {
            throw new Error(
                "You've enabled schema reporting by setting the APOLLO_SCHEMA_REPORTING environment " +
                    'variable to true, but you also need to provide your Apollo API key, via the ' +
                    'APOLLO_KEY environment variable.',
            );
        }
        const { ApolloServerPluginSchemaReporting } = require('@apollo/server/plugin/schemaReporting');
        result.push(ApolloServerPluginSchemaReporting());
    }
    return result;
}

/**
 * Port of `@nestjs/apollo`'s `createPreserveHttpStatusPlugin()` (enabled by default in
 * `@nestjs/apollo` 14, which Vendure used until it switched to Yoga): once execution has produced a
 * response with a `data` key, the HTTP status is reset to 200, even when a resolver threw an error
 * carrying `extensions.http.status`. Request-level failures (parse, validation, variable coercion)
 * have no `data` key and keep their status.
 *
 * @see https://github.com/nestjs/graphql/issues/2940
 */
export function createPreserveHttpStatusPlugin(): ApolloServerPlugin<any> {
    return {
        async requestDidStart() {
            return {
                async willSendResponse(requestContext) {
                    const body = requestContext.response?.body;
                    if (
                        body?.kind === 'single' &&
                        'data' in (body.singleResult ?? {}) &&
                        requestContext.response?.http
                    ) {
                        requestContext.response.http.status = 200;
                    }
                },
            };
        },
    };
}

/**
 * @description
 * Builds the Apollo Server plugin compatibility layer the way Vendure runs it: the given plugins
 * plus `@nestjs/apollo`'s status handling and Apollo Server's implicit plugins, with
 * `GraphQLServerContext.apollo` taken from the environment.
 */
export function createVendureApolloServerPluginsCompat(
    userPlugins: Array<ApolloServerPlugin<any>>,
    options: {
        logger: ApolloLogger;
        getRequestHeaders?: ApolloServerPluginCompatOptions['getRequestHeaders'];
        env?: NodeJS.ProcessEnv;
    },
): ApolloServerPluginsCompat {
    const apollo = determineApolloConfig(options.env);
    const plugins = withApolloServerDefaultPlugins([...userPlugins, createPreserveHttpStatusPlugin()], {
        apollo,
        logger: options.logger,
        env: options.env,
    });
    return createApolloServerPluginsCompat({
        plugins,
        apollo,
        getRequestHeaders: options.getRequestHeaders,
    });
}
