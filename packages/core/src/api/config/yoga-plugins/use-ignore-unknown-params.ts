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
 * It must be registered as a user plugin: Yoga runs user plugins' `onParams` hooks before its own
 * built-in parameter validation.
 */
export function useIgnoreUnknownParams(): Plugin {
    return {
        onParams({ params, setParams }) {
            if (params == null || typeof params !== 'object' || Array.isArray(params)) {
                return;
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
