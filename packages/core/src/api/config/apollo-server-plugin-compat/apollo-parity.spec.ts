/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await */
/**
 * Differential tests for the Apollo Server plugin compatibility layer.
 *
 * Every scenario below is executed twice with the *same* Apollo Server plugins:
 *
 * 1. by a real `ApolloServer` (the server Vendure used before), and
 * 2. by GraphQL Yoga configured the way Vendure configures it (`useApolloCompatibleErrors()` +
 *    `useApolloServerPlugins()`).
 *
 * The tests then assert that the plugins observed exactly the same sequence of lifecycle hooks
 * (with the same request-context values at every step) and that the client received the same HTTP
 * status and the same response body. This is what "not a breaking change for people who wrote
 * Apollo Server plugins" means in practice.
 */
import { ApolloServer, ApolloServerPlugin, GraphQLRequestListener, HeaderMap } from '@apollo/server';
import { ApolloServerPluginCacheControl } from '@apollo/server/plugin/cacheControl';
import { ApolloServerPluginInlineTrace } from '@apollo/server/plugin/inlineTrace';
import { GraphQLError } from 'graphql';
import { createSchema, createYoga } from 'graphql-yoga';
import { describe, expect, it } from 'vitest';

import { useApolloCompatibleErrors } from '../yoga-plugins/use-apollo-compatible-errors';
import { useIgnoreUnknownParams } from '../yoga-plugins/use-ignore-unknown-params';

import { useApolloServerPlugins } from './use-apollo-server-plugins';

const typeDefs = /* GraphQL */ `
    type Product {
        id: ID!
        name: String!
        price: Int!
    }
    type Query {
        product(id: ID!): Product
        products(take: Int!): [Product!]!
        boom: String
        forbidden: String
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
                `requestDidStart op=${rc.request.operationName ?? '-'} vars=${JSON.stringify(rc.request.variables ?? null)}`,
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
                    t(`didEncounterErrors ${r.errors.map(e => e.message).join('|')}`);
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

interface Outcome {
    status: number;
    body: any;
    headers: Record<string, string>;
}

interface RequestSpec {
    method?: 'GET' | 'POST';
    body?: Record<string, unknown>;
    search?: string;
}

async function runOnApollo(plugins: Array<ApolloServerPlugin<any>>, req: RequestSpec): Promise<Outcome> {
    const server = new ApolloServer({
        typeDefs,
        resolvers,
        plugins,
        csrfPrevention: false,
        includeStacktraceInErrorResponses: false,
        // Vendure never enabled Apollo's landing pages in production; keep the trace free of them.
        introspection: true,
    });
    await server.start();
    try {
        const headers = new HeaderMap([['content-type', 'application/json']]);
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
    } finally {
        await server.stop();
    }
}

async function runOnYoga(plugins: Array<ApolloServerPlugin<any>>, req: RequestSpec): Promise<Outcome> {
    const yoga = createYoga({
        schema: createSchema({ typeDefs, resolvers }),
        maskedErrors: false,
        logging: false,
        plugins: [useApolloCompatibleErrors(), useIgnoreUnknownParams(), useApolloServerPlugins({ plugins })],
    });
    try {
        const url = `http://localhost/graphql${req.search ?? ''}`;
        const response = await yoga.fetch(url, {
            method: req.method ?? 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => (headers[key] = value));
        return { status: response.status, body: JSON.parse(await response.text()), headers };
    } finally {
        await yoga.dispose();
    }
}

/** Only the parts of an error which a GraphQL client can observe and which Vendure relies on. */
function normalizeBody(body: any) {
    return {
        data: body.data,
        errors: body.errors?.map((e: any) => ({
            message: e.message,
            path: e.path,
            code: e.extensions?.code,
        })),
    };
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

    it('a plugin that sets HTTP status and headers', async () => {
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
            { body: { query: '{ product(id: "1") { id } }' } },
            status,
        );
        expect(yogaTrace).toEqual(apolloTrace);
        expect(yoga.status).toBe(418);
        expect(yoga.status).toBe(apollo.status);
        expect(yoga.headers['x-powered-by-plugin']).toBe(apollo.headers['x-powered-by-plugin']);
    });

    describe("Apollo Server's own plugins", () => {
        it('ApolloServerPluginInlineTrace (federated tracing via willResolveField) produces a trace', async () => {
            const req: RequestSpec = { body: { query: '{ products(take: 2) { id name price } }' } };
            const plugins = () => [ApolloServerPluginInlineTrace({ includeErrors: { unmodified: true } })];
            // inline trace only runs when the gateway asks for it
            const headersReq = { ...req };
            const apolloServer = new ApolloServer({
                typeDefs,
                resolvers,
                plugins: plugins(),
                csrfPrevention: false,
            });
            await apolloServer.start();
            const apolloRes = await apolloServer.executeHTTPGraphQLRequest({
                httpGraphQLRequest: {
                    method: 'POST',
                    headers: new HeaderMap([
                        ['content-type', 'application/json'],
                        ['apollo-federation-include-trace', 'ftv1'],
                    ]),
                    search: '',
                    body: headersReq.body,
                },
                context: async () => ({}),
            });
            await apolloServer.stop();
            const apolloBody = JSON.parse((apolloRes.body as any).string);

            const yoga = createYoga({
                schema: createSchema({ typeDefs, resolvers }),
                logging: false,
                plugins: [useApolloCompatibleErrors(), useApolloServerPlugins({ plugins: plugins() })],
            });
            const yogaRes = await yoga.fetch('http://localhost/graphql', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'apollo-federation-include-trace': 'ftv1' },
                body: JSON.stringify(req.body),
            });
            const yogaBody = await yogaRes.json();
            await yoga.dispose();

            expect(typeof apolloBody.extensions?.ftv1).toBe('string');
            expect(typeof yogaBody.extensions?.ftv1).toBe('string');
            expect(yogaBody.data).toEqual(apolloBody.data);
        });

        it('ApolloServerPluginCacheControl computes the same Cache-Control header', async () => {
            const cacheTypeDefs = typeDefs.replace(
                'type Product {',
                'enum CacheControlScope { PUBLIC PRIVATE }\n' +
                    'directive @cacheControl(maxAge: Int, scope: CacheControlScope, inheritMaxAge: Boolean) on FIELD_DEFINITION | OBJECT | INTERFACE | UNION\n' +
                    'type Product @cacheControl(maxAge: 60) {',
            );
            const plugins = () => [ApolloServerPluginCacheControl({ defaultMaxAge: 30 })];
            const body = { query: '{ product(id: "1") { id name } }' };

            const apolloServer = new ApolloServer({
                typeDefs: cacheTypeDefs,
                resolvers,
                plugins: plugins(),
                csrfPrevention: false,
            });
            await apolloServer.start();
            const apolloRes = await apolloServer.executeHTTPGraphQLRequest({
                httpGraphQLRequest: {
                    method: 'POST',
                    headers: new HeaderMap([['content-type', 'application/json']]),
                    search: '',
                    body,
                },
                context: async () => ({}),
            });
            await apolloServer.stop();

            const yoga = createYoga({
                schema: createSchema({ typeDefs: cacheTypeDefs, resolvers }),
                logging: false,
                plugins: [useApolloCompatibleErrors(), useApolloServerPlugins({ plugins: plugins() })],
            });
            const yogaRes = await yoga.fetch('http://localhost/graphql', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            await yoga.dispose();

            expect(apolloRes.headers.get('cache-control')).toBe('max-age=60, public');
            expect(yogaRes.headers.get('cache-control')).toBe(apolloRes.headers.get('cache-control'));
        });
    });
});
