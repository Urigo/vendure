import { GraphQLError } from 'graphql';
import { Plugin } from 'graphql-yoga';

const GRAPHQL_PARAMS = ['query', 'variables', 'operationName', 'extensions'] as const;

/**
 * @description
 * Apollo Server ignores top-level request-body keys other than `query`, `variables`,
 * `operationName` and `extensions`, whereas GraphQL Yoga rejects them with
 * `400 Unexpected parameter "…" in the request body`. Clients do send such keys (Relay's
 * `id`/`documentId`, custom tracking fields, padding), so this plugin drops them before Yoga's
 * check runs, keeping Apollo's behaviour.
 *
 * It also answers a request without a query (and without a persisted-query hash) with Apollo's
 * `400 BAD_REQUEST` error, where Yoga would report a syntax error.
 *
 * It must be registered as a user plugin: Yoga runs user plugins' `onParams` hooks before its own
 * built-in parameter validation.
 */
export function useIgnoreUnknownParams(): Plugin {
    return {
        onParams({ params, setParams }) {
            if (params == null || typeof params !== 'object' || Array.isArray(params)) {
                return;
            }
            const { query, extensions } = params as { query?: unknown; extensions?: any };
            if ((query == null || query === '') && !extensions?.persistedQuery) {
                throw new GraphQLError(
                    'GraphQL operations must contain a non-empty `query` or a `persistedQuery` extension.',
                    { extensions: { code: 'BAD_REQUEST', http: { status: 400 } } },
                );
            }
            const hasUnknownKey = Object.keys(params).some(
                key => !(GRAPHQL_PARAMS as readonly string[]).includes(key),
            );
            if (!hasUnknownKey) {
                return;
            }
            const known: Record<string, unknown> = {};
            for (const key of GRAPHQL_PARAMS) {
                if (key in params) {
                    known[key] = (params as Record<string, unknown>)[key];
                }
            }
            setParams(known as typeof params);
        },
    };
}
