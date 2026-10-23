/**
 * Minimal re-implementations of the small Apollo Server runtime values which an
 * `ApolloServerPlugin` expects to find on its `GraphQLRequestContext`.
 *
 * These are intentionally dependency-free (only `graphql`) so that this directory can be
 * lifted out of Vendure as-is, e.g. into a `@graphql-yoga/plugin-apollo-server-compat` package.
 * The behaviour mirrors `@apollo/server` v4/v5:
 *
 * - `HeaderMap`: `utils/HeaderMap.ts` (a `Map` with case-insensitive keys)
 * - `newCachePolicy`: `cachePolicy.ts`
 * - `InMemoryKeyValueCache`: the subset of `@apollo/utils.keyvaluecache` which `requestContext.cache`
 *   exposes, backed by a bounded `Map`
 */
import { createHash } from 'crypto';
import { GraphQLError, Kind } from 'graphql';

/**
 * Case-insensitive header map, API-compatible with Apollo Server's `HeaderMap`.
 */
export class HeaderMap extends Map<string, string> {
    // Apollo's HeaderMap carries this marker so that `instanceof` checks across package
    // copies can fall back to a structural check.
    readonly __identity = Symbol('HeaderMap');

    override set(key: string, value: string): this {
        return super.set(key.toLowerCase(), value);
    }

    override get(key: string): string | undefined {
        return super.get(key.toLowerCase());
    }

    override delete(key: string): boolean {
        return super.delete(key.toLowerCase());
    }

    override has(key: string): boolean {
        return super.has(key.toLowerCase());
    }
}

export type CacheScope = 'PUBLIC' | 'PRIVATE';

export interface CacheHint {
    maxAge?: number;
    scope?: CacheScope;
}

export interface CachePolicy extends CacheHint {
    restrict(hint: CacheHint): void;
    replace(hint: CacheHint): void;
    policyIfCacheable(): Required<CacheHint> | null;
}

/**
 * Port of Apollo Server's `newCachePolicy()`.
 */
export function newCachePolicy(): CachePolicy {
    return {
        maxAge: undefined,
        scope: undefined,
        restrict(hint: CacheHint) {
            if (hint.maxAge !== undefined && (this.maxAge === undefined || hint.maxAge < this.maxAge)) {
                this.maxAge = hint.maxAge;
            }
            if (hint.scope !== undefined && this.scope !== 'PRIVATE') {
                this.scope = hint.scope;
            }
        },
        replace(hint: CacheHint) {
            if (hint.maxAge !== undefined) {
                this.maxAge = hint.maxAge;
            }
            if (hint.scope !== undefined) {
                this.scope = hint.scope;
            }
        },
        policyIfCacheable() {
            if (this.maxAge === undefined || this.maxAge === 0) {
                return null;
            }
            return { maxAge: this.maxAge, scope: this.scope ?? 'PUBLIC' };
        },
    };
}

export interface KeyValueCache<V = string> {
    get(key: string): Promise<V | undefined>;
    set(key: string, value: V, options?: { ttl?: number | null }): Promise<void>;
    delete(key: string): Promise<boolean | void>;
}

/**
 * A small bounded in-memory cache which stands in for Apollo Server's default
 * `InMemoryLRUCache`. Plugins which call `requestContext.cache.get()/set()` keep working;
 * anything which needs a shared or persistent cache should bring its own.
 */
export class InMemoryKeyValueCache implements KeyValueCache<string> {
    private readonly store = new Map<string, { value: string; expiresAt?: number }>();

    constructor(private readonly maxSize = 1000) {}

    async get(key: string): Promise<string | undefined> {
        const entry = this.store.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt !== undefined && entry.expiresAt < Date.now()) {
            this.store.delete(key);
            return undefined;
        }
        // refresh LRU position
        this.store.delete(key);
        this.store.set(key, entry);
        return entry.value;
    }

    async set(key: string, value: string, options?: { ttl?: number | null }): Promise<void> {
        if (this.store.size >= this.maxSize && !this.store.has(key)) {
            const oldest = this.store.keys().next().value;
            if (oldest !== undefined) {
                this.store.delete(oldest);
            }
        }
        this.store.set(key, {
            value,
            expiresAt: options?.ttl ? Date.now() + options.ttl * 1000 : undefined,
        });
    }

    async delete(key: string): Promise<boolean> {
        return this.store.delete(key);
    }
}

/**
 * Port of Apollo Server's `computeQueryHash()`.
 */
export function computeQueryHash(query: string): string {
    return createHash('sha256').update(query).digest('hex');
}

/**
 * Port of Apollo Server's `ensureGraphQLError()`: anything thrown by a plugin hook is
 * surfaced to the client as a GraphQLError, exactly as Apollo does.
 */
export function ensureGraphQLError(maybeError: unknown): GraphQLError {
    const error = maybeError instanceof Error ? maybeError : new Error(String(maybeError));
    return error instanceof GraphQLError ? error : new GraphQLError(error.message, { originalError: error });
}

/**
 * Port of Apollo Server's `isBadUserInputGraphQLError()`: detects the variable-coercion
 * errors which graphql-js raises before execution starts.
 */
export function isBadUserInputGraphQLError(error: GraphQLError): boolean {
    const node = error.nodes?.[0];
    if (error.nodes?.length !== 1 || node?.kind !== Kind.VARIABLE_DEFINITION) {
        return false;
    }
    const name = node.variable.name.value;
    return (
        error.message.startsWith(`Variable "$${name}" has invalid value`) ||
        error.message.startsWith(`Variable "$${name}" got invalid value `) ||
        error.message.startsWith(`Variable "$${name}" of required type `) ||
        error.message.startsWith(`Variable "$${name}" of non-null type `)
    );
}

/**
 * Port of Apollo Server's `invokeDidStartHook()`: runs the `*DidStart` hooks of all listeners
 * and returns a single function which runs the returned `*DidEnd` hooks in reverse order.
 */
export async function invokeDidStartHook<T, TArgs extends any[]>(
    targets: readonly T[],
    hook: (target: T) => Promise<((...args: TArgs) => Promise<void> | void) | void> | void,
): Promise<(...args: TArgs) => Promise<void>> {
    const didEndHooks = (await Promise.all(targets.map(target => hook(target)))).filter(
        (fn): fn is (...args: TArgs) => Promise<void> | void => typeof fn === 'function',
    );
    didEndHooks.reverse();
    return async (...args: TArgs) => {
        for (const didEndHook of didEndHooks) {
            await didEndHook(...args);
        }
    };
}

/**
 * Port of Apollo Server's `invokeSyncDidStartHook()`, used for `willResolveField`.
 */
export function invokeSyncDidStartHook<T, TArgs extends any[]>(
    targets: readonly T[],
    hook: (target: T) => ((...args: TArgs) => void) | void,
): (...args: TArgs) => void {
    const didEndHooks = targets
        .map(target => hook(target))
        .filter((fn): fn is (...args: TArgs) => void => typeof fn === 'function');
    didEndHooks.reverse();
    return (...args: TArgs) => {
        for (const didEndHook of didEndHooks) {
            didEndHook(...args);
        }
    };
}

/**
 * Port of Apollo Server's `invokeHooksUntilDefinedAndNonNull()`, used for `responseForOperation`.
 */
export async function invokeHooksUntilDefinedAndNonNull<T, R>(
    targets: readonly T[],
    hook: (target: T) => Promise<R | null | undefined>,
): Promise<R | null> {
    for (const target of targets) {
        const value = await hook(target);
        if (value != null) {
            return value;
        }
    }
    return null;
}
