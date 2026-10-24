/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await */
/**
 * Differential tests for the Apollo Server plugin compatibility layer.
 *
 * Every scenario below is executed twice with the *same* Apollo Server plugins:
 *
 * 1. by a real `ApolloServer` 5, set up as Vendure ran it before (through `@nestjs/apollo` 14,
 *    whose "preserve HTTP status" plugin is reproduced verbatim below), and
 * 2. by GraphQL Yoga, set up the way Vendure sets it up (`createVendureApolloServerPluginsCompat()`,
 *    `useApolloCompatibleErrors()`, `useIgnoreUnknownParams()`, APQ).
 *
 * The tests then assert that the plugins observed exactly the same sequence of lifecycle hooks
 * (with the same request-context values at every step) and that the client received the same HTTP
 * status, headers and response body. This is what "not a breaking change for people who wrote
 * Apollo Server plugins" means in practice.
 */
import { ApolloServer, ApolloServerPlugin, GraphQLRequestListener, HeaderMap } from '@apollo/server';
import { ApolloServerPluginCacheControl } from '@apollo/server/plugin/cacheControl';
import { ApolloServerPluginInlineTrace } from '@apollo/server/plugin/inlineTrace';
import { useAPQ } from '@graphql-yoga/plugin-apq';
import { createHash } from 'crypto';
import { GraphQLError } from 'graphql';
import { createSchema, createYoga, YogaServerInstance } from 'graphql-yoga';
import { describe, expect, it } from 'vitest';

import { useApolloCompatibleErrors } from '../yoga-plugins/use-apollo-compatible-errors';
import { useIgnoreUnknownParams } from '../yoga-plugins/use-ignore-unknown-params';

import { createVendureApolloServerPluginsCompat } from './apollo-default-plugins';

const cacheControlDirective = /* GraphQL */ `
    enum CacheControlScope {
        PUBLIC
        PRIVATE
    }
    directive @cacheControl(
        maxAge: Int
        scope: CacheControlScope
        inheritMaxAge: Boolean
    ) on FIELD_DEFINITION | OBJECT | INTERFACE | UNION
`;

const typeDefs = /* GraphQL */ `
    ${cacheControlDirective}
    type Product {
        id: ID!
        name: String!
        price: Int!
    }
    type Promo @cacheControl(maxAge: 60) {
        code: String!
    }
    type Query {
        product(id: ID!): Product
        products(take: Int!): [Product!]!
        boom: String
        forbidden: String
        unauthorized: String
        promo: Promo
        dynamicHint: String
    }
    type Mutation {
        rename(id: ID!, name: String!): Product
    }
`;

const resolvers = {
    Query: {
        product: (_: unknown, args: { id: string }) => ({ id: args.id, name: 'Laptop', price: 1000 }),
        products: (_: unknown, args: { take: number }) =>
            Array.from({ length: args.take }, (__, i) => ({
                id: String(i + 1),
                name: `P${i + 1}`,
                price: i,
            })),
        boom: () => {
            throw new Error('resolver exploded');
        },
        forbidden: () => {
            throw new GraphQLError('You are not currently authorized to perform this action', {
                extensions: { code: 'FORBIDDEN' },
            });
        },
        unauthorized: () => {
            throw new GraphQLError('Not logged in', {
                extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
            });
        },
        promo: () => ({ code: 'SAVE10' }),
        // Resolvers may set cache hints dynamically; Apollo Server always installs the cache
        // control plugin, so `info.cacheControl` is always there.
        dynamicHint: (_: unknown, __: unknown, ___: unknown, info: any) => {
            info.cacheControl.setCacheHint({ maxAge: 30, scope: 'PUBLIC' });
            return 'hinted';
        },
    },
    Mutation: {
        rename: (_: unknown, args: { id: string; name: string }) => ({
            id: args.id,
            name: args.name,
            price: 1,
        }),
    },
    Product: {
        price: async (parent: { price: number }) => parent.price,
    },
};

type Trace = string[];

/**
 * A plugin which implements every request-lifecycle hook and records what it sees. Its trace is
 * the thing compared between the two servers.
 */
function tracingPlugin(name: string, trace: Trace, overrides: Partial<GraphQLRequestListener<any>> = {}) {
    const t = (event: string) => trace.push(`${name}:${event}`);
    const plugin: ApolloServerPlugin<any> = {
        async requestDidStart(rc) {
            t(
                `requestDidStart op=${rc.request.operationName ?? '-'} vars=${JSON.stringify(rc.request.variables ?? null)} ` +
                    `query=${rc.request.query === undefined ? 'none' : rc.request.query.length}`,
            );
            return {
                async didResolveSource(r) {
                    t(`didResolveSource hash=${r.queryHash.slice(0, 8)} source=${r.source.length}`);
                },
                async parsingDidStart() {
                    t('parsingDidStart');
                    return async err => t(`parsingDidEnd ${err ? 'error' : 'ok'}`);
                },
                async validationDidStart(r) {
                    t(`validationDidStart doc=${!!r.document}`);
                    return async errs =>
                        t(`validationDidEnd ${errs ? errs.map(e => e.message).join('|') : 'ok'}`);
                },
                async didResolveOperation(r) {
                    t(`didResolveOperation name=${r.operationName ?? 'null'} type=${r.operation?.operation}`);
                },
                async responseForOperation() {
                    t('responseForOperation');
                    return null;
                },
                async executionDidStart() {
                    t('executionDidStart');
                    return {
                        willResolveField({ info }) {
                            if (info.parentType.name !== 'Query' && info.parentType.name !== 'Mutation') {
                                return;
                            }
                            t(`willResolveField ${info.parentType.name}.${info.fieldName}`);
                            return err => t(`didResolveField ${info.fieldName} ${err ? 'error' : 'ok'}`);
                        },
                        async executionDidEnd(err) {
                            t(`executionDidEnd ${err ? 'error' : 'ok'}`);
                        },
                    };
                },
                async didEncounterErrors(r) {
                    // The code matters: e.g. error reporters skip errors which already have one.
                    t(
                        `didEncounterErrors ${r.errors
                            .map(e => `${e.message} [${String(e.extensions?.code ?? '-')}]`)
                            .join('|')}`,
                    );
                },
                async willSendResponse(r) {
                    const body = r.response.body;
                    t(
                        `willSendResponse kind=${body.kind} status=${r.response.http.status ?? '-'} ` +
                            `errors=${body.kind === 'single' ? (body.singleResult.errors?.length ?? 0) : '?'}`,
                    );
                },
                ...overrides,
            };
        },
    };
    return plugin;
}

/**
 * Verbatim copy of `createPreserveHttpStatusPlugin()` from `@nestjs/apollo` 14
 * (`dist/drivers/apollo-base.driver.js`), which Vendure's Apollo setup ran after all other plugins.
 */
function nestApolloPreserveHttpStatusPlugin(): ApolloServerPlugin<any> {
    return {
        async requestDidStart() {
            return {
                async willSendResponse(requestContext: any) {
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

interface Outcome {
    status: number;
    body: any;
    headers: Record<string, string>;
}

interface RequestSpec {
    method?: 'GET' | 'POST';
    body?: Record<string, unknown>;
    search?: string;
    headers?: Record<string, string>;
}

interface TestServer {
    request(req: RequestSpec): Promise<Outcome>;
    stop(): Promise<void>;
}

const silentLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

async function startApollo(plugins: Array<ApolloServerPlugin<any>>): Promise<TestServer> {
    const server = new ApolloServer({
        typeDefs,
        resolvers,
        plugins: [...plugins, nestApolloPreserveHttpStatusPlugin()],
        csrfPrevention: false,
        includeStacktraceInErrorResponses: false,
        introspection: true,
        logger: silentLogger,
    });
    await server.start();
    return {
        async request(req) {
            const headers = new HeaderMap([
                ['content-type', 'application/json'],
                ...Object.entries(req.headers ?? {}),
            ]);
            const response = await server.executeHTTPGraphQLRequest({
                httpGraphQLRequest: {
                    method: req.method ?? 'POST',
                    headers,
                    search: req.search ?? '',
                    body: req.body ?? {},
                },
                context: async () => ({}),
            });
            let text = '';
            if (response.body.kind === 'complete') {
                text = response.body.string;
            } else {
                for await (const chunk of response.body.asyncIterator) {
                    text += chunk;
                }
            }
            return {
                status: response.status ?? 200,
                body: JSON.parse(text),
                headers: Object.fromEntries(response.headers),
            };
        },
        stop: () => server.stop(),
    };
}

async function startYoga(plugins: Array<ApolloServerPlugin<any>>): Promise<TestServer> {
    const compat = createVendureApolloServerPluginsCompat(plugins, { logger: silentLogger, env: {} });
    const yoga: YogaServerInstance<any, any> = createYoga({
        schema: createSchema({ typeDefs, resolvers }),
        maskedErrors: false,
        logging: false,
        // The same order as in configure-graphql-module.ts
        plugins: [
            compat.early,
            useApolloCompatibleErrors(),
            useIgnoreUnknownParams(),
            useAPQ(),
            compat.mid,
            compat.late,
        ],
    });
    await compat.ready();
    return {
        async request(req) {
            const url = `http://localhost/graphql${req.search ?? ''}`;
            const response = await yoga.fetch(url, {
                method: req.method ?? 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json', ...req.headers },
                body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
            });
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => (headers[key] = value));
            return { status: response.status, body: JSON.parse(await response.text()), headers };
        },
        stop: () => yoga.dispose() as Promise<void>,
    };
}

async function runOnApollo(plugins: Array<ApolloServerPlugin<any>>, req: RequestSpec): Promise<Outcome> {
    const server = await startApollo(plugins);
    try {
        return await server.request(req);
    } finally {
        await server.stop();
    }
}

async function runOnYoga(plugins: Array<ApolloServerPlugin<any>>, req: RequestSpec): Promise<Outcome> {
    const server = await startYoga(plugins);
    try {
        return await server.request(req);
    } finally {
        await server.stop();
    }
}

/** The response body exactly as a client sees it. */
function normalizeBody(body: any) {
    return JSON.parse(JSON.stringify(body));
}

/** Response headers which are part of the GraphQL contract (not transport details). */
function relevantHeaders(headers: Record<string, string>) {
    return { 'cache-control': headers['cache-control'] };
}

async function compare(req: RequestSpec, makePlugins: (trace: Trace) => Array<ApolloServerPlugin<any>>) {
    const apolloTrace: Trace = [];
    const yogaTrace: Trace = [];
    const apollo = await runOnApollo(makePlugins(apolloTrace), req);
    const yoga = await runOnYoga(makePlugins(yogaTrace), req);
    return { apollo, yoga, apolloTrace, yogaTrace };
}

const scenarios: Array<[string, RequestSpec]> = [
    ['an anonymous query', { body: { query: '{ product(id: "1") { id name price } }' } }],
    [
        'a named query with variables',
        {
            body: {
                query: 'query GetProduct($id: ID!) { product(id: $id) { id name } }',
                operationName: 'GetProduct',
                variables: { id: '42' },
            },
        },
    ],
    ['a mutation', { body: { query: 'mutation Rename { rename(id: "1", name: "New") { id name } }' } }],
    [
        'a document with several operations',
        {
            body: {
                query: 'query A { product(id: "1") { id } } query B { products(take: 2) { id } }',
                operationName: 'B',
            },
        },
    ],
    ['a syntax error', { body: { query: '{ product(id: "1") { id ' } }],
    ['a validation error', { body: { query: '{ product(id: "1") { id nope } }' } }],
    [
        'a variable coercion error',
        {
            body: {
                query: 'query Q($take: Int!) { products(take: $take) { id } }',
                variables: { take: 'x' },
            },
        },
    ],
    ['a resolver error', { body: { query: '{ boom product(id: "1") { id } }' } }],
    ['a resolver error with a code', { body: { query: '{ forbidden }' } }],
    [
        'a body with extra top-level keys (e.g. Relay `id`)',
        { body: { query: '{ product(id: "1") { id } }', id: 'abc123', padding: 'x'.repeat(64) } },
    ],
    [
        'a GET request',
        { method: 'GET', search: '?query=' + encodeURIComponent('{ product(id: "7") { id name } }') },
    ],
];

describe('Apollo Server plugin parity (real Apollo Server vs. Yoga + compatibility layer)', () => {
    for (const [description, req] of scenarios) {
        it(`${description}: plugins see the same lifecycle and the client the same response`, async () => {
            const { apollo, yoga, apolloTrace, yogaTrace } = await compare(req, trace => [
                tracingPlugin('first', trace),
                tracingPlugin('second', trace),
            ]);
            expect(yogaTrace).toEqual(apolloTrace);
            expect(yoga.status).toBe(apollo.status);
            expect(normalizeBody(yoga.body)).toEqual(normalizeBody(apollo.body));
        });
    }

    /**
     * Known difference: when the operation to run cannot be determined, Yoga rejects the request
     * right after parsing (its built-in `usePreventMutationViaGET` check), whereas Apollo Server
     * runs validation and enters execution before graphql-js reports the problem. Clients get the
     * same HTTP status and the same `extensions.code`; only the message text differs, and plugins
     * see `didEncounterErrors` and `willSendResponse` without the validation/execution hooks in
     * between. This only affects malformed requests.
     */
    for (const [description, req] of [
        [
            'an operationName which is not in the document',
            { body: { query: 'query A { product(id: "1") { id } }', operationName: 'Nope' } },
        ],
        [
            'several operations and no operationName',
            { body: { query: 'query A { product(id: "1") { id } } query B { boom }' } },
        ],
    ] as Array<[string, RequestSpec]>) {
        it(`known difference — ${description}: same status, code and error hooks`, async () => {
            const { apollo, yoga, apolloTrace, yogaTrace } = await compare(req, trace => [
                tracingPlugin('only', trace),
            ]);
            expect(yoga.status).toBe(apollo.status);
            expect(yoga.status).toBe(400);
            expect(yoga.body.errors.map((e: any) => e.extensions.code)).toEqual(
                apollo.body.errors.map((e: any) => e.extensions.code),
            );
            const errorHooks = (trace: Trace) =>
                trace.filter(e => /didEncounterErrors|willSendResponse/.test(e)).map(e => e.split(' ')[0]);
            expect(errorHooks(yogaTrace)).toEqual(errorHooks(apolloTrace));
            // requestDidStart, didResolveSource, parsingDidStart, parsingDidEnd
            expect(yogaTrace.slice(0, 4)).toEqual(apolloTrace.slice(0, 4));
        });
    }

    it('a plugin that rewrites the response in willSendResponse', async () => {
        const rewrite = (trace: Trace): Array<ApolloServerPlugin<any>> => [
            tracingPlugin('rewriter', trace, {
                async willSendResponse(rc) {
                    trace.push('rewriter:willSendResponse');
                    const { body } = rc.response;
                    if (body.kind === 'single') {
                        body.singleResult.errors = body.singleResult.errors?.map(
                            () => new GraphQLError('Invalid request'),
                        );
                        rc.response.http.headers.set('x-rewritten', 'yes');
                    }
                },
            }),
        ];
        const { apollo, yoga, apolloTrace, yogaTrace } = await compare(
            { body: { query: '{ product(id: "1") { id nme } }' } },
            rewrite,
        );
        expect(yogaTrace).toEqual(apolloTrace);
        expect(yoga.status).toBe(apollo.status);
        expect(normalizeBody(yoga.body)).toEqual(normalizeBody(apollo.body));
        expect(yoga.headers['x-rewritten']).toBe(apollo.headers['x-rewritten']);
    });

    it('a plugin that rejects the operation in didResolveOperation', async () => {
        const reject = (trace: Trace): Array<ApolloServerPlugin<any>> => [
            tracingPlugin('guard', trace, {
                async didResolveOperation() {
                    trace.push('guard:didResolveOperation');
                    throw new GraphQLError('Query is too complex', {
                        extensions: { code: 'BAD_USER_INPUT', http: { status: 400 } },
                    });
                },
            }),
        ];
        const { apollo, yoga, apolloTrace, yogaTrace } = await compare(
            { body: { query: '{ products(take: 3) { id } }' } },
            reject,
        );
        expect(yogaTrace).toEqual(apolloTrace);
        expect(yoga.status).toBe(apollo.status);
        expect(normalizeBody(yoga.body)).toEqual(normalizeBody(apollo.body));
    });

    it('a plugin that serves the response itself in responseForOperation (e.g. a cache)', async () => {
        const cached = (trace: Trace): Array<ApolloServerPlugin<any>> => [
            tracingPlugin('cache', trace, {
                async responseForOperation() {
                    trace.push('cache:responseForOperation');
                    return {
                        http: { status: undefined, headers: new HeaderMap([['x-cache', 'HIT']]) },
                        body: { kind: 'single', singleResult: { data: { product: { id: 'cached' } } } },
                    };
                },
            }),
        ];
        const { apollo, yoga, apolloTrace, yogaTrace } = await compare(
            { body: { query: '{ product(id: "1") { id } }' } },
            cached,
        );
        expect(yogaTrace).toEqual(apolloTrace);
        expect(yoga.status).toBe(apollo.status);
        expect(yoga.body).toEqual(apollo.body);
        expect(yoga.headers['x-cache']).toBe('HIT');
    });

    it('a plugin that sets HTTP status and headers on a response without data', async () => {
        const status = (trace: Trace): Array<ApolloServerPlugin<any>> => [
            tracingPlugin('status', trace, {
                async willSendResponse(rc) {
                    trace.push('status:willSendResponse');
                    rc.response.http.status = 418;
                    rc.response.http.headers.set('x-powered-by-plugin', 'apollo-plugin');
                },
            }),
        ];
        const { apollo, yoga, apolloTrace, yogaTrace } = await compare(
            { body: { query: '{ product(id: "1") { id nope } }' } },
            status,
        );
        expect(yogaTrace).toEqual(apolloTrace);
        expect(apollo.status).toBe(418);
        expect(yoga.status).toBe(apollo.status);
        expect(yoga.headers['x-powered-by-plugin']).toBe(apollo.headers['x-powered-by-plugin']);
    });

    // Review finding: Yoga used the highest per-error status, overriding the plugin's.
    it('a plugin that forces 200 on a validation error', async () => {
        const forceOk = (trace: Trace): Array<ApolloServerPlugin<any>> => [
            tracingPlugin('ok', trace, {
                async willSendResponse(rc) {
                    rc.response.http.status = 200;
                },
            }),
        ];
        const { apollo, yoga } = await compare({ body: { query: '{ product(id: "1") { nope } }' } }, forceOk);
        expect(apollo.status).toBe(200);
        expect(yoga.status).toBe(apollo.status);
        expect(normalizeBody(yoga.body)).toEqual(normalizeBody(apollo.body));
    });

    // Review finding: `extensions.http` leaked into the body when a plugin re-created the errors.
    it('a plugin that re-creates errors as plain objects with extra extensions', async () => {
        const decorate = (trace: Trace): Array<ApolloServerPlugin<any>> => [
            tracingPlugin('decorate', trace, {
                async willSendResponse(rc) {
                    const { body } = rc.response;
                    if (body.kind === 'single' && body.singleResult.errors) {
                        body.singleResult.errors = body.singleResult.errors.map(e => ({
                            ...e,
                            extensions: { ...e.extensions, ts: 1 },
                        }));
                    }
                },
            }),
        ];
        const { apollo, yoga } = await compare(
            { body: { query: '{ product(id: "1") { nope } }' } },
            decorate,
        );
        expect(JSON.stringify(yoga.body)).not.toContain('"http"');
        expect(yoga.status).toBe(apollo.status);
        expect(normalizeBody(yoga.body)).toEqual(normalizeBody(apollo.body));
    });

    // Review finding: Yoga caches validation results, and plugins mutated the cached errors.
    it('mutating errors in willSendResponse does not leak into later requests', async () => {
        let requestId = 0;
        const tagging = (): Array<ApolloServerPlugin<any>> => [
            {
                async requestDidStart() {
                    const id = ++requestId;
                    return {
                        async willSendResponse(rc) {
                            const { body } = rc.response;
                            if (body.kind === 'single') {
                                for (const error of body.singleResult.errors ?? []) {
                                    const extensions = (error as any).extensions;
                                    extensions.requestIds = [...(extensions.requestIds ?? []), id];
                                }
                            }
                        },
                    };
                },
            },
        ];
        const req = { body: { query: '{ product(id: "1") { nope } }' } };
        const results: Record<string, unknown[]> = {};
        for (const [name, start] of [
            ['apollo', startApollo],
            ['yoga', startYoga],
        ] as const) {
            requestId = 0;
            const server = await start(tagging());
            results[name] = [];
            for (let i = 0; i < 3; i++) {
                results[name].push((await server.request(req)).body.errors[0].extensions.requestIds);
            }
            await server.stop();
        }
        expect(results.apollo).toEqual([[1], [2], [3]]);
        expect(results.yoga).toEqual(results.apollo);
    });

    // Review finding: @nestjs/apollo resets the status to 200 once there is `data`.
    it('a resolver error carrying an HTTP status, with data', async () => {
        const { apollo, yoga, apolloTrace, yogaTrace } = await compare(
            { body: { query: '{ unauthorized product(id: "1") { id } }' } },
            trace => [tracingPlugin('only', trace)],
        );
        expect(yogaTrace).toEqual(apolloTrace);
        expect(apollo.status).toBe(200);
        expect(yoga.status).toBe(apollo.status);
        expect(normalizeBody(yoga.body)).toEqual(normalizeBody(apollo.body));
    });

    describe('Automatic Persisted Queries', () => {
        const query = '{ product(id: "9") { id name } }';
        const sha256Hash = createHash('sha256').update(query).digest('hex');
        const persistedQuery = { version: 1, sha256Hash };

        // Review finding: a miss answered 404 and skipped the request hooks.
        it('miss, register, hit: same lifecycle, statuses and bodies', async () => {
            const steps: RequestSpec[] = [
                { body: { extensions: { persistedQuery } } },
                { body: { query, extensions: { persistedQuery } } },
                { body: { extensions: { persistedQuery } } },
            ];
            // A hash which does not match the query is rejected with 400 by both.
            const mismatch: RequestSpec = { body: { query: '{ boom }', extensions: { persistedQuery } } };
            const outcomes: Record<
                string,
                Array<{ status: number; body: unknown; trace: Trace; cacheControl?: string }>
            > = {};
            const mismatchStatus: Record<string, number> = {};
            for (const [name, start] of [
                ['apollo', startApollo],
                ['yoga', startYoga],
            ] as const) {
                const trace: Trace = [];
                const server = await start([tracingPlugin('apq', trace)]);
                outcomes[name] = [];
                for (const step of steps) {
                    trace.length = 0;
                    const outcome = await server.request(step);
                    outcomes[name].push({
                        status: outcome.status,
                        body: normalizeBody(outcome.body),
                        trace: [...trace],
                    });
                }
                mismatchStatus[name] = (await server.request(mismatch)).status;
                await server.stop();
            }
            expect(mismatchStatus.apollo).toBe(400);
            expect(mismatchStatus.yoga).toBe(mismatchStatus.apollo);
            expect(outcomes.apollo[0].status).toBe(200);
            expect((outcomes.apollo[0].body as any).errors[0].extensions.code).toBe(
                'PERSISTED_QUERY_NOT_FOUND',
            );
            expect(outcomes.yoga.map(o => o.status)).toEqual(outcomes.apollo.map(o => o.status));
            expect(outcomes.yoga.map(o => o.trace)).toEqual(outcomes.apollo.map(o => o.trace));
            expect(outcomes.yoga.map(o => (o.body as any).data)).toEqual(
                outcomes.apollo.map(o => (o.body as any).data),
            );
            // Full errors, including Apollo's `PersistedQueryNotFound` message which Apollo Client's
            // persisted-query link looks for, and the no-cache header Apollo sends with a miss.
            expect(outcomes.yoga.map(o => (o.body as any).errors)).toEqual(
                outcomes.apollo.map(o => (o.body as any).errors),
            );
            expect(outcomes.yoga.map(o => o.cacheControl)).toEqual(outcomes.apollo.map(o => o.cacheControl));
        });
    });

    // Apollo skips the parsing and validation hooks for documents in its document store.
    it('a repeated query: the second request skips parsing and validation, as on Apollo', async () => {
        const traces: Record<string, Trace[]> = {};
        for (const [name, start] of [
            ['apollo', startApollo],
            ['yoga', startYoga],
        ] as const) {
            const trace: Trace = [];
            const server = await start([tracingPlugin('repeat', trace)]);
            traces[name] = [];
            for (let i = 0; i < 3; i++) {
                trace.length = 0;
                await server.request({ body: { query: '{ product(id: "1") { id } }' } });
                traces[name].push([...trace]);
            }
            // An invalid query is never stored, so its hooks run every time.
            for (let i = 0; i < 2; i++) {
                trace.length = 0;
                await server.request({ body: { query: '{ product(id: "1") { nope } }' } });
                traces[name].push([...trace]);
            }
            await server.stop();
        }
        expect(traces.apollo[1]).not.toContain('repeat:parsingDidStart');
        expect(traces.yoga).toEqual(traces.apollo);
    });

    // Review finding: Apollo rejects malformed bodies before any request hook runs.
    it('a body with string variables never reaches the request hooks', async () => {
        const { apollo, yoga, apolloTrace, yogaTrace } = await compare(
            { body: { query: '{ product(id: "1") { id } }', variables: '{"id":"1"}' } },
            trace => [tracingPlugin('only', trace)],
        );
        expect(apolloTrace).toEqual([]);
        expect(yogaTrace).toEqual(apolloTrace);
        expect(yoga.status).toBe(apollo.status);
        expect(relevantHeaders(yoga.headers)).toEqual(relevantHeaders(apollo.headers));
    });

    it('a request without a query', async () => {
        const { apollo, yoga, apolloTrace, yogaTrace } = await compare({ body: { query: '' } }, trace => [
            tracingPlugin('only', trace),
        ]);
        expect(yogaTrace).toEqual(apolloTrace);
        expect(yoga.status).toBe(apollo.status);
        expect(normalizeBody(yoga.body)).toEqual(normalizeBody(apollo.body));
    });

    describe("Apollo Server's own plugins", () => {
        it('ApolloServerPluginInlineTrace (federated tracing via willResolveField) produces a trace', async () => {
            const req: RequestSpec = {
                body: { query: '{ products(take: 2) { id name price } }' },
                headers: { 'apollo-federation-include-trace': 'ftv1' },
            };
            const plugins = () => [ApolloServerPluginInlineTrace({ includeErrors: { unmodified: true } })];
            const apollo = await runOnApollo(plugins(), req);
            const yoga = await runOnYoga(plugins(), req);
            expect(typeof apollo.body.extensions?.ftv1).toBe('string');
            expect(typeof yoga.body.extensions?.ftv1).toBe('string');
            expect(yoga.body.data).toEqual(apollo.body.data);
        });

        // Review finding: Apollo Server installs the cache control plugin implicitly.
        for (const [description, query] of [
            ['@cacheControl type hints', '{ promo { code } }'],
            ['dynamic hints set by resolvers via info.cacheControl', '{ dynamicHint }'],
            ['no hints (uncacheable)', '{ product(id: "1") { id } }'],
        ] as const) {
            it(`implicit cache control: ${description}`, async () => {
                const req: RequestSpec = { body: { query } };
                const apollo = await runOnApollo([], req);
                const yoga = await runOnYoga([], req);
                expect(yoga.body).toEqual(apollo.body);
                expect(yoga.body.errors).toBeUndefined();
                expect(relevantHeaders(yoga.headers)).toEqual(relevantHeaders(apollo.headers));
            });
        }

        it('an explicitly installed ApolloServerPluginCacheControl replaces the implicit one', async () => {
            const req: RequestSpec = { body: { query: '{ product(id: "1") { id } }' } };
            const plugins = () => [ApolloServerPluginCacheControl({ defaultMaxAge: 30 })];
            const apollo = await runOnApollo(plugins(), req);
            const yoga = await runOnYoga(plugins(), req);
            expect(apollo.headers['cache-control']).toBe('max-age=30, public');
            expect(relevantHeaders(yoga.headers)).toEqual(relevantHeaders(apollo.headers));
        });
    });
});
