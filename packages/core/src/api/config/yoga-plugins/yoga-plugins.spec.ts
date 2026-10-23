/* eslint-disable @typescript-eslint/no-explicit-any */
import { GraphQLError } from 'graphql';
import { createSchema, createYoga, YogaServerInstance } from 'graphql-yoga';
import { afterEach, describe, expect, it } from 'vitest';

import { useApolloCompatibleErrors } from './use-apollo-compatible-errors';
import { useCsrfPrevention } from './use-csrf-prevention';
import { useValidationRules } from './use-validation-rules';

const schema = createSchema({
    typeDefs: /* GraphQL */ `
        type Query {
            product(id: ID!): String
            fails: String
            httpFails: String
        }
    `,
    resolvers: {
        Query: {
            product: (_: unknown, args: { id: string }) => `product-${args.id}`,
            fails: () => {
                throw new Error('plain error');
            },
            httpFails: () => {
                // The shape of a NestJS HttpException
                const err: any = new Error('Forbidden resource');
                err.status = 403;
                err.response = { statusCode: 403, message: 'Forbidden resource' };
                throw err;
            },
        },
    },
});

async function post(yoga: YogaServerInstance<any, any>, body: unknown, headers: Record<string, string> = {}) {
    const response = await yoga.fetch('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

describe('useApolloCompatibleErrors()', () => {
    const yoga = createYoga({ schema, logging: false, maskedErrors: false, plugins: [useApolloCompatibleErrors()] });

    afterEach(async () => {
        await yoga.dispose();
    });

    it('GRAPHQL_PARSE_FAILED / 400 for syntax errors', async () => {
        const { status, body } = await post(yoga, { query: '{ product(id: ' });
        expect(status).toBe(400);
        expect(body.errors[0].extensions.code).toBe('GRAPHQL_PARSE_FAILED');
    });

    it('GRAPHQL_VALIDATION_FAILED / 400 for validation errors', async () => {
        const { status, body } = await post(yoga, { query: '{ nope }' });
        expect(status).toBe(400);
        expect(body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
        expect(body.errors[0].message).toContain('Cannot query field "nope"');
    });

    it('BAD_USER_INPUT / 400 for variable coercion errors', async () => {
        const { status, body } = await post(yoga, {
            query: 'query ($id: ID!) { product(id: $id) }',
            variables: { id: { not: 'an id' } },
        });
        expect(status).toBe(400);
        expect(body.data).toBeUndefined();
        expect(body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    });

    it('OPERATION_RESOLUTION_FAILURE / 400 when the operation cannot be selected', async () => {
        const { status, body } = await post(yoga, {
            query: 'query A { product(id: "1") } query B { product(id: "2") }',
        });
        expect(status).toBe(400);
        expect(body.errors[0].extensions.code).toBe('OPERATION_RESOLUTION_FAILURE');
    });

    it('INTERNAL_SERVER_ERROR / 200 for resolver errors without a code, keeping the message', async () => {
        const { status, body } = await post(yoga, { query: '{ fails }' });
        expect(status).toBe(200);
        expect(body.data).toEqual({ fails: null });
        expect(body.errors[0].message).toBe('plain error');
        expect(body.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
        expect(body.errors[0].extensions.stacktrace).toBeUndefined();
    });

    it('maps NestJS HttpExceptions like @nestjs/apollo did', async () => {
        const { body } = await post(yoga, { query: '{ httpFails }' });
        expect(body.errors[0].extensions.code).toBe('FORBIDDEN');
        expect(body.errors[0].extensions.originalError).toEqual({ statusCode: 403, message: 'Forbidden resource' });
    });

    it('BAD_REQUEST / 400 for requests which never reach an operation', async () => {
        const { status, body } = await post(yoga, '');
        expect(status).toBe(400);
        expect(body.errors[0].extensions.code).toBe('BAD_REQUEST');
        expect(body.errors[0].extensions.stacktrace).toBeUndefined();
    });
});

describe('useCsrfPrevention()', () => {
    let yoga: YogaServerInstance<any, any>;

    afterEach(async () => {
        await yoga?.dispose();
    });

    it('blocks non-preflighted content types with Apollo\'s 400 BAD_REQUEST response', async () => {
        yoga = createYoga({ schema, logging: false, plugins: [useCsrfPrevention(true)] });
        for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain']) {
            const { status, body, text } = await post(yoga, '{ "query": "{ product(id: \\"1\\") }" }', {
                'content-type': contentType,
            });
            expect(status).toBe(400);
            expect(text).toContain('Cross-Site Request Forgery');
            expect(body.errors[0].extensions.code).toBe('BAD_REQUEST');
        }
    });

    it('allows application/json', async () => {
        yoga = createYoga({ schema, logging: false, plugins: [useCsrfPrevention(true)] });
        const { status, body } = await post(yoga, { query: '{ product(id: "1") }' });
        expect(status).toBe(200);
        expect(body.data.product).toBe('product-1');
    });

    it('blocks a bare GET and allows it with Apollo-Require-Preflight', async () => {
        yoga = createYoga({ schema, logging: false, plugins: [useCsrfPrevention(true)] });
        const url = `http://localhost/graphql?query=${encodeURIComponent('{ product(id: "1") }')}`;
        const blocked = await yoga.fetch(url);
        expect(blocked.status).toBe(400);
        const allowed = await yoga.fetch(url, { headers: { 'apollo-require-preflight': 'true' } });
        expect(allowed.status).toBe(200);
        const allowedByOperationName = await yoga.fetch(url, { headers: { 'x-apollo-operation-name': 'x' } });
        expect(allowedByOperationName.status).toBe(200);
    });

    it('honours a custom requestHeaders list', async () => {
        yoga = createYoga({
            schema,
            logging: false,
            plugins: [useCsrfPrevention({ requestHeaders: ['x-my-client'] })],
        });
        const url = `http://localhost/graphql?query=${encodeURIComponent('{ product(id: "1") }')}`;
        expect((await yoga.fetch(url, { headers: { 'apollo-require-preflight': 'true' } })).status).toBe(400);
        expect((await yoga.fetch(url, { headers: { 'x-my-client': '1' } })).status).toBe(200);
    });
});

describe('useValidationRules()', () => {
    it('disables introspection with the graphql-js rule Apollo Server used', async () => {
        const yoga = createYoga({
            schema,
            logging: false,
            plugins: [useApolloCompatibleErrors(), useValidationRules({ rules: [], introspection: false })],
        });
        const { status, body } = await post(yoga, { query: '{ __schema { types { name } } }' });
        expect(status).toBe(400);
        expect(body.errors[0].message).toContain('GraphQL introspection has been disabled');
        expect(body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
        await yoga.dispose();
    });

    it('applies custom validation rules', async () => {
        const yoga = createYoga({
            schema,
            logging: false,
            plugins: [
                useValidationRules({
                    rules: [
                        context => ({
                            Field(node) {
                                if (node.name.value === 'fails') {
                                    context.reportError(new GraphQLError('fails is banned'));
                                }
                            },
                        }),
                    ],
                    introspection: true,
                }),
            ],
        });
        const { body } = await post(yoga, { query: '{ fails }' });
        expect(body.errors[0].message).toBe('fails is banned');
        await yoga.dispose();
    });
});
