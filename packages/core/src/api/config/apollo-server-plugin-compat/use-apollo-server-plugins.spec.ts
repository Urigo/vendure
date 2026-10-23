/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ApolloServerPlugin, GraphQLRequestListener } from '@apollo/server';
import { createSchema, createYoga, YogaServerInstance } from 'graphql-yoga';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useApolloServerPlugins } from './use-apollo-server-plugins';

const schema = createSchema({
    typeDefs: /* GraphQL */ `
        type Product {
            id: ID!
            name: String!
            price: Int!
        }
        type Query {
            product(id: ID!): Product
            boom: String
        }
    `,
    resolvers: {
        Query: {
            product: (_: unknown, args: { id: string }) => ({ id: args.id, name: 'Laptop', price: 1000 }),
            boom: () => {
                throw new Error('resolver exploded');
            },
        },
        Product: {
            price: async (parent: { price: number }) => parent.price,
        },
    },
});

/**
 * Records the order in which Apollo Server plugin hooks are invoked, so that the sequence can
 * be compared against the one Apollo Server itself produces.
 */
function createRecordingPlugin(overrides: Partial<GraphQLRequestListener<any>> = {}) {
    const events: string[] = [];
    const plugin: ApolloServerPlugin<any> = {
        async serverWillStart(service) {
            events.push(`serverWillStart(${service.schema.getQueryType()?.name ?? '?'})`);
            return {
                async serverWillStop() {
                    events.push('serverWillStop');
                },
                async drainServer() {
                    events.push('drainServer');
                },
            };
        },
        async requestDidStart(requestContext) {
            events.push(`requestDidStart(${requestContext.request.operationName ?? 'anon'})`);
            return {
                async didResolveSource(rc) {
                    events.push(`didResolveSource(${rc.queryHash.slice(0, 6)})`);
                },
                async parsingDidStart() {
                    events.push('parsingDidStart');
                    return async err => {
                        events.push(`parsingDidEnd(${err ? 'error' : 'ok'})`);
                    };
                },
                async validationDidStart() {
                    events.push('validationDidStart');
                    return async errs => {
                        events.push(`validationDidEnd(${errs ? errs.length : 'ok'})`);
                    };
                },
                async didResolveOperation(rc) {
                    events.push(
                        `didResolveOperation(${rc.operationName ?? 'null'}:${rc.operation?.operation})`,
                    );
                },
                async executionDidStart() {
                    events.push('executionDidStart');
                    return {
                        async executionDidEnd(err) {
                            events.push(`executionDidEnd(${err ? 'error' : 'ok'})`);
                        },
                    };
                },
                async didEncounterErrors(rc) {
                    events.push(`didEncounterErrors(${rc.errors.length})`);
                },
                async willSendResponse(rc) {
                    events.push(`willSendResponse(${rc.response.body.kind})`);
                },
                ...overrides,
            };
        },
        async invalidRequestWasReceived({ error }) {
            events.push(`invalidRequestWasReceived(${error.message.slice(0, 20)})`);
        },
    };
    return { plugin, events };
}

async function post(yoga: YogaServerInstance<any, any>, body: unknown, headers: Record<string, string> = {}) {
    const response = await yoga.fetch('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
}

describe('useApolloServerPlugins()', () => {
    let yoga: YogaServerInstance<any, any>;
    let events: string[];
    let plugin: ApolloServerPlugin<any>;

    beforeEach(() => {
        ({ plugin, events } = createRecordingPlugin());
        yoga = createYoga({
            schema,
            maskedErrors: false,
            logging: false,
            plugins: [useApolloServerPlugins({ plugins: [plugin] })],
        });
    });

    afterEach(async () => {
        await yoga.dispose();
    });

    it('calls serverWillStart once with the schema', async () => {
        expect(events).toEqual(['serverWillStart(Query)']);
    });

    it('invokes the request lifecycle hooks in the same order as Apollo Server', async () => {
        events.length = 0;
        const { status, body } = await post(yoga, {
            query: 'query GetProduct($id: ID!) { product(id: $id) { id name } }',
            operationName: 'GetProduct',
            variables: { id: '1' },
        });

        expect(status).toBe(200);
        expect(body).toEqual({ data: { product: { id: '1', name: 'Laptop' } } });
        expect(events).toEqual([
            'requestDidStart(GetProduct)',
            expect.stringMatching(/^didResolveSource\([0-9a-f]{6}\)$/),
            'parsingDidStart',
            'parsingDidEnd(ok)',
            'validationDidStart',
            'validationDidEnd(ok)',
            'didResolveOperation(GetProduct:query)',
            'executionDidStart',
            'executionDidEnd(ok)',
            'willSendResponse(single)',
        ]);
    });

    it('exposes the mutable response body to willSendResponse', async () => {
        const { plugin: mutating } = createRecordingPlugin({
            async willSendResponse(rc) {
                if (rc.response.body.kind === 'single' && rc.response.body.singleResult.data) {
                    (rc.response.body.singleResult.data as any).product.name = 'Encoded Laptop';
                    rc.response.http.headers.set('x-apollo-plugin', 'ran');
                }
            },
        });
        await yoga.dispose();
        yoga = createYoga({
            schema,
            logging: false,
            plugins: [useApolloServerPlugins({ plugins: [mutating] })],
        });

        const { body, headers } = await post(yoga, { query: '{ product(id: "1") { id name } }' });

        expect(body.data.product.name).toBe('Encoded Laptop');
        expect(headers.get('x-apollo-plugin')).toBe('ran');
    });

    it('reports validation errors through didEncounterErrors and willSendResponse', async () => {
        events.length = 0;
        const { status, body } = await post(yoga, { query: '{ product(id: "1") { nope } }' });

        expect(status).toBe(400);
        expect(body.errors[0].message).toContain('Cannot query field "nope"');
        expect(events).toEqual([
            'requestDidStart(anon)',
            expect.stringMatching(/^didResolveSource/),
            'parsingDidStart',
            'parsingDidEnd(ok)',
            'validationDidStart',
            'validationDidEnd(1)',
            'didEncounterErrors(1)',
            'willSendResponse(single)',
        ]);
    });

    it('reports parse errors through parsingDidEnd and didEncounterErrors', async () => {
        events.length = 0;
        const { status } = await post(yoga, { query: '{ product(id: ' });

        expect(status).toBe(400);
        expect(events).toContain('parsingDidEnd(error)');
        expect(events).toContain('didEncounterErrors(1)');
        expect(events.at(-1)).toBe('willSendResponse(single)');
    });

    it('reports resolver errors through didEncounterErrors before willSendResponse', async () => {
        events.length = 0;
        const { status, body } = await post(yoga, { query: '{ boom }' });

        expect(status).toBe(200);
        expect(body.errors[0].message).toBe('resolver exploded');
        expect(events.slice(-3)).toEqual([
            'didEncounterErrors(1)',
            'executionDidEnd(ok)',
            'willSendResponse(single)',
        ]);
    });

    it('turns an error thrown from didResolveOperation into the response, as Apollo does', async () => {
        const { plugin: rejecting, events: rejectingEvents } = createRecordingPlugin({
            async didResolveOperation() {
                throw new Error('Query is too complex');
            },
        });
        await yoga.dispose();
        yoga = createYoga({
            schema,
            logging: false,
            plugins: [useApolloServerPlugins({ plugins: [rejecting] })],
        });
        rejectingEvents.length = 0;

        const { status, body } = await post(yoga, { query: '{ product(id: "1") { id } }' });

        expect(status).toBe(500);
        expect(body.data).toBeUndefined();
        expect(body.errors).toEqual([{ message: 'Query is too complex' }]);
        expect(rejectingEvents).not.toContain('executionDidStart');
        expect(rejectingEvents.slice(-2)).toEqual(['didEncounterErrors(1)', 'willSendResponse(single)']);
    });

    it('lets responseForOperation short-circuit execution', async () => {
        const { plugin: cached, events: cachedEvents } = createRecordingPlugin({
            async responseForOperation() {
                return {
                    body: { kind: 'single', singleResult: { data: { product: { id: 'cached' } } } },
                    http: { status: 200, headers: new Map([['x-cache', 'HIT']]) as any },
                };
            },
        });
        await yoga.dispose();
        yoga = createYoga({
            schema,
            logging: false,
            plugins: [useApolloServerPlugins({ plugins: [cached] })],
        });

        const { body, headers } = await post(yoga, { query: '{ product(id: "1") { id } }' });

        expect(body).toEqual({ data: { product: { id: 'cached' } } });
        expect(headers.get('x-cache')).toBe('HIT');
        expect(cachedEvents).not.toContain('executionDidStart');
    });

    it('supports willResolveField via schema instrumentation', async () => {
        const resolved: string[] = [];
        const { plugin: tracing } = createRecordingPlugin({
            async executionDidStart() {
                return {
                    willResolveField({ info }) {
                        const path = `${info.parentType.name}.${info.fieldName}`;
                        return (error, result) => {
                            resolved.push(`${path}=${error ? 'error' : JSON.stringify(result)}`);
                        };
                    },
                };
            },
        });
        await yoga.dispose();
        yoga = createYoga({
            schema,
            logging: false,
            plugins: [useApolloServerPlugins({ plugins: [tracing] })],
        });

        await post(yoga, { query: '{ product(id: "1") { name price } }' });

        expect(resolved).toEqual(
            expect.arrayContaining([
                'Query.product={"id":"1","name":"Laptop","price":1000}',
                'Product.name="Laptop"',
                'Product.price=1000',
            ]),
        );
    });

    it('calls invalidRequestWasReceived when the request never reaches an operation', async () => {
        events.length = 0;
        const { status } = await post(yoga, '{ not json');

        expect(status).toBe(400);
        expect(events).toEqual([expect.stringMatching(/^invalidRequestWasReceived\(/)]);
    });

    it('calls serverWillStop and drainServer when the server is disposed', async () => {
        await yoga.dispose();

        expect(events).toContain('drainServer');
        expect(events).toContain('serverWillStop');
    });

    it('runs multiple plugins in order and their *DidEnd hooks in reverse order', async () => {
        const first = createRecordingPlugin();
        const second = createRecordingPlugin();
        const order: string[] = [];
        for (const [name, recorder] of [
            ['first', first],
            ['second', second],
        ] as const) {
            const recorded = recorder.plugin;
            const original = recorded.requestDidStart?.bind(recorded);
            recorded.requestDidStart = async rc => {
                order.push(`${name}:requestDidStart`);
                const listener = (await original?.(rc)) as GraphQLRequestListener<any>;
                return {
                    ...listener,
                    async executionDidStart() {
                        order.push(`${name}:executionDidStart`);
                        return {
                            async executionDidEnd() {
                                order.push(`${name}:executionDidEnd`);
                            },
                        };
                    },
                };
            };
        }
        await yoga.dispose();
        yoga = createYoga({
            schema,
            logging: false,
            plugins: [useApolloServerPlugins({ plugins: [first.plugin, second.plugin] })],
        });

        await post(yoga, { query: '{ product(id: "1") { id } }' });

        expect(order).toEqual([
            'first:requestDidStart',
            'second:requestDidStart',
            'first:executionDidStart',
            'second:executionDidStart',
            'second:executionDidEnd',
            'first:executionDidEnd',
        ]);
    });

    it('does nothing when no plugins are configured', async () => {
        await yoga.dispose();
        yoga = createYoga({ schema, logging: false, plugins: [useApolloServerPlugins({ plugins: [] })] });
        const spy = vi.fn();
        void spy;

        const { status, body } = await post(yoga, { query: '{ product(id: "1") { id } }' });

        expect(status).toBe(200);
        expect(body.data.product.id).toBe('1');
    });
});
