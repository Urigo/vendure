/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await */
import { ApolloServerPlugin } from '@apollo/server';
import { ApolloServerPluginCacheControl } from '@apollo/server/plugin/cacheControl';
import { ApolloServerPluginCacheControlDisabled } from '@apollo/server/plugin/disabled';
import { createSchema, createYoga } from 'graphql-yoga';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createVendureApolloServerPluginsCompat,
    determineApolloConfig,
    withApolloServerDefaultPlugins,
} from './apollo-default-plugins';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const ids = (plugins: Array<ApolloServerPlugin<any>>) =>
    plugins.map(p => (p as any).__internal_plugin_id__ ?? 'user');
const user: ApolloServerPlugin<any> = { requestDidStart: async () => undefined };

describe('withApolloServerDefaultPlugins()', () => {
    afterEach(() => {
        delete process.env.APOLLO_SCHEMA_REPORTING;
    });

    it('adds cache control after the given plugins, as ApolloServer.start() does', () => {
        expect(ids(withApolloServerDefaultPlugins([user], { apollo: {}, logger }))).toEqual([
            'user',
            'CacheControl',
        ]);
    });

    it('respects an explicitly installed or disabled cache control plugin', () => {
        expect(
            ids(
                withApolloServerDefaultPlugins([ApolloServerPluginCacheControl({ defaultMaxAge: 5 })], {
                    apollo: {},
                    logger,
                }),
            ),
        ).toEqual(['CacheControl']);
        const disabled = withApolloServerDefaultPlugins([ApolloServerPluginCacheControlDisabled()], {
            apollo: {},
            logger,
        });
        expect(disabled).toHaveLength(1);
        expect((disabled[0] as any).__is_disabled_plugin__).toBe(true);
    });

    it('refuses an enabled and a disabled variant of the same plugin', () => {
        expect(() =>
            withApolloServerDefaultPlugins(
                [ApolloServerPluginCacheControl(), ApolloServerPluginCacheControlDisabled()],
                {
                    apollo: {},
                    logger,
                },
            ),
        ).toThrow(/both ApolloServerPluginCacheControl and ApolloServerPluginCacheControlDisabled/);
    });

    it('adds usage reporting first when an Apollo key and graph ref are configured', () => {
        const apollo = determineApolloConfig({
            APOLLO_KEY: 'service:test:abc',
            APOLLO_GRAPH_REF: 'test@current',
        });
        expect(apollo.graphRef).toBe('test@current');
        expect(apollo.keyHash).toMatch(/^[0-9a-f]{128}$/);
        expect(ids(withApolloServerDefaultPlugins([user], { apollo, logger }))).toEqual([
            'UsageReporting',
            'user',
            'CacheControl',
        ]);
    });

    it('warns instead of reporting usage when there is a key but no graph ref', () => {
        logger.warn.mockClear();
        const apollo = determineApolloConfig({ APOLLO_KEY: 'service:test:abc' });
        expect(ids(withApolloServerDefaultPlugins([user], { apollo, logger }))).toEqual([
            'user',
            'CacheControl',
        ]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('usage reporting is disabled'));
    });

    it('requires a key for APOLLO_SCHEMA_REPORTING=true, as Apollo Server does', () => {
        process.env.APOLLO_SCHEMA_REPORTING = 'true';
        expect(() => withApolloServerDefaultPlugins([], { apollo: {}, logger })).toThrow(/APOLLO_KEY/);
    });
});

describe('startup (serverWillStart)', () => {
    const schema = createSchema({
        typeDefs: 'type Query { ok: Boolean }',
        resolvers: { Query: { ok: () => true } },
    });

    function yogaWith(plugins: Array<ApolloServerPlugin<any>>) {
        const compat = createVendureApolloServerPluginsCompat(plugins, { logger, env: {} });
        const yoga = createYoga({ schema, logging: false, plugins: [compat.early, compat.late] });
        return { compat, yoga };
    }

    it('ready() waits for an asynchronous serverWillStart', async () => {
        let finished = false;
        const { compat, yoga } = yogaWith([
            {
                async serverWillStart() {
                    await new Promise(resolve => setTimeout(resolve, 20));
                    finished = true;
                },
            },
        ]);
        await compat.ready();
        expect(finished).toBe(true);
        await yoga.dispose();
    });

    it('ready() rejects and startupDidFail is called when serverWillStart throws', async () => {
        const startupDidFail = vi.fn();
        const { compat, yoga } = yogaWith([
            {
                async serverWillStart() {
                    throw new Error('cannot connect to the tracing backend');
                },
                startupDidFail,
            },
        ]);
        await expect(compat.ready()).rejects.toThrow('cannot connect to the tracing backend');
        expect(startupDidFail).toHaveBeenCalledWith({ error: expect.any(Error) });
        await yoga.dispose();
    });

    it('requests wait for serverWillStart to complete', async () => {
        const events: string[] = [];
        const { yoga } = yogaWith([
            {
                async serverWillStart() {
                    await new Promise(resolve => setTimeout(resolve, 20));
                    events.push('started');
                },
                async requestDidStart() {
                    events.push('request');
                },
            },
        ]);
        await yoga.fetch('http://localhost/graphql', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: '{ ok }' }),
        });
        expect(events).toEqual(['started', 'request']);
        await yoga.dispose();
    });
});
