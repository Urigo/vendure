/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
    ApolloServerPlugin,
    GraphQLRequestContext,
    GraphQLRequestExecutionListener,
    GraphQLRequestListener,
    GraphQLResponse,
    GraphQLServerListener,
} from '@apollo/server';
import { DocumentNode, ExecutionResult, getOperationAST, GraphQLError, GraphQLSchema } from 'graphql';
import type { Plugin as YogaPlugin } from 'graphql-yoga';

import {
    computeQueryHash,
    ensureGraphQLError,
    HeaderMap,
    InMemoryKeyValueCache,
    invokeDidStartHook,
    invokeHooksUntilDefinedAndNonNull,
    invokeSyncDidStartHook,
    newCachePolicy,
} from './apollo-request-context';
import {
    enablePluginsForSchemaResolvers,
    symbolExecutionDispatcherWillResolveField,
} from './schema-instrumentation';

/**
 * @description
 * Options for {@link useApolloServerPlugins}.
 */
export interface ApolloServerPluginCompatOptions {
    /**
     * @description
     * The Apollo Server plugins to run. Plugins run in array order, exactly as Apollo Server runs
     * them: `requestDidStart` is awaited for all plugins before the request proceeds, and the
     * `*DidEnd` callbacks run in reverse order.
     */
    plugins: ApolloServerPlugin<any>[];
    /**
     * @description
     * The logger exposed as `requestContext.logger` / `GraphQLServerContext.logger`.
     * Defaults to the request-scoped Yoga logger.
     */
    logger?: ApolloLogger;
    /**
     * @description
     * Supplies the headers exposed as `requestContext.request.http.headers`. Defaults to the headers
     * of the Fetch `Request`. Host integrations which know the headers *as the client sent them*
     * (Express, where body-parsing middleware can cause the Fetch request to report a different
     * `content-type`) can supply those instead.
     */
    getRequestHeaders?: (serverContext: any, request: Request) => Iterable<[string, string]>;
}

/**
 * The subset of Apollo's `Logger` interface (`@apollo/utils.logger`) which plugins use.
 */
export interface ApolloLogger {
    debug(message?: any): void;
    info(message?: any): void;
    warn(message?: any): void;
    error(message?: any): void;
}

type RequestListener = GraphQLRequestListener<any>;
type ExecutionListener = GraphQLRequestExecutionListener<any>;

/**
 * The mutable form of Apollo's `GraphQLRequestContext`. Apollo itself builds the context as a
 * plain mutable object and exposes it to plugins through the readonly interface.
 */
type MutableRequestContext = {
    -readonly [K in keyof GraphQLRequestContext<any>]: GraphQLRequestContext<any>[K];
};

/**
 * Per-operation bookkeeping, keyed by Yoga's per-operation context object (which is the same
 * object for the whole lifecycle of one operation, batched or not).
 */
interface OperationState {
    requestContext: MutableRequestContext;
    listeners: RequestListener[];
    executionListeners: ExecutionListener[];
    /** Resolves once every `parsingDidEnd` callback has run. */
    parsingDone?: Promise<void>;
    /** Resolves once every `validationDidEnd` callback has run. */
    validationDone?: Promise<void>;
    /** `didEncounterErrors` has already been invoked for the errors currently on the context. */
    errorsReported: boolean;
    /** `executionDidStart` listeners have been resolved and `executionDidEnd` has been invoked. */
    executionEnded: boolean;
    /** A plugin's `responseForOperation` short-circuited execution. */
    responseFromPlugin: boolean;
}

const stateByContext = new WeakMap<object, OperationState>();
const batchedByServerContext = new WeakMap<object, boolean>();

/**
 * @description
 * An Envelop/Yoga plugin which runs [Apollo Server plugins](https://www.apollographql.com/docs/apollo-server/integrations/plugins/)
 * against GraphQL Yoga, mapping Apollo's request-lifecycle hooks onto Yoga's.
 *
 * It exists so that code written against the `ApolloServerPlugin` interface keeps working
 * unchanged after the server underneath has been swapped from Apollo Server to Yoga. The
 * `GraphQLRequestContext` handed to plugins is a faithful reproduction of Apollo's: the same
 * properties, the same mutability (`response.body.singleResult.data|errors`,
 * `response.http.status|headers`), the same ordering rules, and the same behaviour when a hook
 * throws.
 *
 * ## Hook mapping
 *
 * | Apollo Server hook                               | Yoga / Envelop hook                                   |
 * |--------------------------------------------------|-------------------------------------------------------|
 * | `serverWillStart`                                | first `onSchemaChange`                                |
 * | `GraphQLServerListener.schemaDidLoadOrUpdate`    | subsequent `onSchemaChange`                           |
 * | `GraphQLServerListener.serverWillStop/drainServer` | `onDispose` (`yoga.dispose()`)                      |
 * | `requestDidStart`, `didResolveSource`            | `onParams`                                            |
 * | `parsingDidStart` → `parsingDidEnd`              | `onParse` → after-parse                               |
 * | `validationDidStart` → `validationDidEnd`        | `onValidate` → after-validate                         |
 * | `didResolveOperation`, `responseForOperation`    | `onExecute` (before execution)                        |
 * | `executionDidStart` → `executionDidEnd`          | `onExecute` → `onExecuteDone`                         |
 * | `willResolveField`                               | schema resolver instrumentation (identical to Apollo) |
 * | `didEncounterErrors`                             | after-parse / after-validate / `onExecuteDone` / `onExecutionResult` |
 * | `willSendResponse`                               | `onExecutionResult`                                   |
 * | `willSendSubsequentPayload`                      | `onExecutionResult` (streamed results)                |
 * | `invalidRequestWasReceived`                      | `onResultProcess` (request rejected before any operation ran) |
 *
 * ## Known differences
 *
 * - `parsingDidStart` and `validationDidStart` are invoked synchronously (Envelop's parse and
 *   validate hooks are synchronous); their returned `*DidEnd` callbacks are awaited before
 *   `didResolveOperation` runs, so timing plugins see the same sequence of events.
 * - `requestContext.response.body.singleResult.errors` contains `GraphQLError` instances rather
 *   than already-formatted plain objects. They serialize identically and can be mutated or
 *   replaced in the same way.
 * - `GraphQLServerListener.renderLandingPage` is ignored: Yoga serves its own GraphiQL.
 * - `requestContext.cache` is a small in-memory cache rather than Apollo's `InMemoryLRUCache`.
 * - Subscriptions and incremental delivery are passed through: `willSendResponse` is called with
 *   `body.kind === 'incremental'` for streamed results.
 *
 * @example
 * ```ts
 * import { createYoga } from 'graphql-yoga';
 * import { useApolloServerPlugins } from './use-apollo-server-plugins';
 *
 * const yoga = createYoga({
 *   schema,
 *   plugins: [useApolloServerPlugins({ plugins: [myExistingApolloPlugin] })],
 * });
 * ```
 */
export function useApolloServerPlugins(options: ApolloServerPluginCompatOptions): YogaPlugin {
    const { plugins } = options;
    const cache = new InMemoryKeyValueCache();
    let serverListeners: Promise<GraphQLServerListener[]> | undefined;
    let currentSchema: GraphQLSchema | undefined;

    const fallbackLogger: ApolloLogger = options.logger ?? {
        /* eslint-disable no-console */
        debug: (msg?: any) => console.debug(msg),
        info: (msg?: any) => console.info(msg),
        warn: (msg?: any) => console.warn(msg),
        error: (msg?: any) => console.error(msg),
        /* eslint-enable no-console */
    };

    function loggerFor(context: any): ApolloLogger {
        if (options.logger) {
            return options.logger;
        }
        const log = context?.log;
        if (log && typeof log.info === 'function') {
            return {
                debug: (msg?: any) => log.debug(msg),
                info: (msg?: any) => log.info(msg),
                warn: (msg?: any) => log.warn(msg),
                error: (msg?: any) => log.error(msg),
            };
        }
        return fallbackLogger;
    }

    async function didEncounterErrors(state: OperationState, errors: readonly GraphQLError[]) {
        state.requestContext.errors = errors;
        state.errorsReported = true;
        await Promise.all(state.listeners.map(l => l.didEncounterErrors?.(state.requestContext as any)));
    }

    /**
     * Mirrors Apollo's `sendErrorResponse()`: an error thrown by a plugin hook becomes the sole
     * error of the response, `didEncounterErrors` is notified, and the HTTP status defaults to 500.
     */
    async function errorResponse(state: OperationState, thrown: unknown): Promise<ExecutionResult> {
        const error = ensureGraphQLError(thrown);
        await didEncounterErrors(state, [error]);
        const http = state.requestContext.response.http;
        if (!http.status) {
            http.status = (error.extensions as any)?.http?.status ?? 500;
        }
        return { errors: [error] };
    }

    function buildHttpRequest(request: Request, context: any, params: any) {
        const headers = new HeaderMap();
        for (const [key, value] of options.getRequestHeaders?.(context, request) ?? requestHeaderEntries(request)) {
            headers.set(key, value);
        }
        let search = '';
        try {
            search = new URL(request.url, 'http://localhost').search;
        } catch {
            /* ignore */
        }
        return { method: request.method, headers, search, body: params };
    }

    function finalizeHttp(state: OperationState, result: ExecutionResult): ExecutionResult {
        const { status, headers } = state.requestContext.response.http;
        if (!status && headers.size === 0) {
            return result;
        }
        const http: { status?: number; headers?: Record<string, string> } = {};
        if (status) {
            http.status = status;
        }
        if (headers.size) {
            http.headers = Object.fromEntries(headers);
        }
        return {
            ...result,
            extensions: { ...(result.extensions as object | undefined), http },
        } as ExecutionResult;
    }

    return {
        onSchemaChange({ schema }) {
            currentSchema = schema;
            if (!serverListeners) {
                const service = {
                    logger: fallbackLogger,
                    cache,
                    schema,
                    apollo: {} as any,
                    startedInBackground: false,
                };
                serverListeners = Promise.all(plugins.map(p => p.serverWillStart?.(service as any))).then(
                    listeners => listeners.filter((l): l is GraphQLServerListener => !!l),
                );
                serverListeners.catch(async error => {
                    await Promise.all(plugins.map(p => p.startupDidFail?.({ error })));
                });
            } else {
                void serverListeners.then(listeners =>
                    listeners.forEach(l => l.schemaDidLoadOrUpdate?.({ apiSchema: schema })),
                );
            }
        },

        async onDispose() {
            const listeners = (await serverListeners?.catch(() => [])) ?? [];
            await Promise.all(listeners.map(l => l.drainServer?.()));
            await Promise.all(listeners.map(l => l.serverWillStop?.()));
        },

        onRequestParse({ serverContext }) {
            return {
                onRequestParseDone({ requestParserResult }) {
                    batchedByServerContext.set(serverContext, Array.isArray(requestParserResult));
                },
            };
        },

        async onParams({ params, request, context }) {
            if (plugins.length === 0) {
                return;
            }
            const requestContext: MutableRequestContext = {
                logger: loggerFor(context),
                cache,
                schema: currentSchema as GraphQLSchema,
                request: {
                    query: params.query,
                    operationName: params.operationName,
                    variables: params.variables,
                    extensions: params.extensions,
                    http: buildHttpRequest(request, context, params) as any,
                },
                response: { http: { status: undefined, headers: new HeaderMap() } } as any,
                contextValue: context,
                metrics: {},
                overallCachePolicy: newCachePolicy(),
                requestIsBatched: batchedByServerContext.get(Object.getPrototypeOf(context) ?? context) ??
                    batchedByServerContext.get(context) ??
                    false,
            };
            const state: OperationState = {
                requestContext,
                listeners: [],
                executionListeners: [],
                errorsReported: false,
                executionEnded: false,
                responseFromPlugin: false,
            };
            stateByContext.set(context, state);

            state.listeners = (await Promise.all(plugins.map(p => p.requestDidStart?.(requestContext as any)))).filter(
                (l): l is RequestListener => !!l,
            );
            if (typeof params.query === 'string') {
                requestContext.source = params.query;
                requestContext.queryHash = computeQueryHash(params.query);
            }
            await Promise.all(state.listeners.map(l => l.didResolveSource?.(requestContext as any)));
        },

        onParse({ context }) {
            const state = stateByContext.get(context);
            if (!state || state.listeners.length === 0) {
                return;
            }
            const parsingDidEnd = invokeDidStartHook(state.listeners, l =>
                l.parsingDidStart?.(state.requestContext as any),
            );
            return ({ result }) => {
                if (result instanceof Error) {
                    state.parsingDone = parsingDidEnd.then(end => end(result));
                } else {
                    state.requestContext.document = result as DocumentNode;
                    state.parsingDone = parsingDidEnd.then(end => end());
                }
                state.parsingDone.catch(() => undefined);
            };
        },

        onValidate({ context }) {
            const state = stateByContext.get(context);
            if (!state || state.listeners.length === 0) {
                return;
            }
            const validationDidEnd = invokeDidStartHook(state.listeners, l =>
                l.validationDidStart?.(state.requestContext as any),
            );
            return ({ valid, result }) => {
                state.validationDone = validationDidEnd.then(end =>
                    end(valid ? undefined : (result as readonly Error[])),
                );
                state.validationDone.catch(() => undefined);
            };
        },

        async onExecute({ args, setResultAndStopExecution }) {
            const state = stateByContext.get(args.contextValue);
            if (!state || state.listeners.length === 0) {
                return;
            }
            const { requestContext, listeners } = state;
            // Make sure the synchronous parse/validate phases have fully reported before the
            // next Apollo phase begins, preserving Apollo's strict ordering.
            await state.parsingDone;
            await state.validationDone;
            requestContext.schema = args.schema;
            requestContext.document = args.document;
            const operation = getOperationAST(args.document, args.operationName);
            requestContext.operation = operation ?? undefined;
            requestContext.operationName = operation?.name?.value || null;

            try {
                await Promise.all(listeners.map(l => l.didResolveOperation?.(requestContext as any)));
            } catch (err) {
                setResultAndStopExecution(await errorResponse(state, err));
                return;
            }

            const responseFromPlugin = await invokeHooksUntilDefinedAndNonNull<RequestListener, GraphQLResponse>(
                listeners,
                async l => (await l.responseForOperation?.(requestContext as any)) ?? null,
            );
            if (responseFromPlugin) {
                state.responseFromPlugin = true;
                if (responseFromPlugin.http) {
                    const http = requestContext.response.http;
                    if (responseFromPlugin.http.status) {
                        http.status = responseFromPlugin.http.status;
                    }
                    responseFromPlugin.http.headers?.forEach((value, key) => http.headers.set(key, value));
                }
                if (responseFromPlugin.body.kind === 'single') {
                    setResultAndStopExecution(responseFromPlugin.body.singleResult as ExecutionResult);
                } else {
                    setResultAndStopExecution(responseFromPlugin.body.initialResult as ExecutionResult);
                }
                return;
            }

            state.executionListeners = (
                await Promise.all(listeners.map(l => l.executionDidStart?.(requestContext as any)))
            ).filter((l): l is ExecutionListener => !!l);
            state.executionListeners.reverse();
            if (state.executionListeners.some(l => l.willResolveField)) {
                const invokeWillResolveField = (...hookArgs: any[]) =>
                    invokeSyncDidStartHook(state.executionListeners, l =>
                        (l.willResolveField as any)?.(...hookArgs),
                    );
                Object.defineProperty(args.contextValue, symbolExecutionDispatcherWillResolveField, {
                    value: invokeWillResolveField,
                    configurable: true,
                });
                enablePluginsForSchemaResolvers(args.schema);
            }

            return {
                async onExecuteDone({ result }) {
                    if (isAsyncIterable(result)) {
                        // Incremental delivery / subscriptions: Apollo reports errors per payload via
                        // `didEncounterSubsequentErrors`, which `onExecutionResult` handles below.
                        return;
                    }
                    if (result.errors?.length) {
                        await didEncounterErrors(state, result.errors);
                    }
                    state.executionEnded = true;
                    await Promise.all(state.executionListeners.map(l => l.executionDidEnd?.()));
                },
            };
        },

        async onExecutionResult({ result, setResult, context }) {
            const state = stateByContext.get(context);
            if (!state || state.listeners.length === 0) {
                return;
            }
            const { requestContext, listeners } = state;

            if (!state.executionEnded && !state.responseFromPlugin && state.executionListeners.length) {
                // Execution itself threw (as opposed to returning errors) and Yoga turned the
                // exception into a result; Apollo would have called `executionDidEnd(error)`.
                state.executionEnded = true;
                const error = (result as ExecutionResult | undefined)?.errors?.[0];
                await Promise.all(state.executionListeners.map(l => l.executionDidEnd?.(error as any)));
            }

            if (result === undefined) {
                return;
            }

            if (isAsyncIterable(result)) {
                setResult(wrapIncrementalResult(result, state));
                return;
            }

            const singleResult = result as ExecutionResult;
            if (singleResult.errors?.length && !state.errorsReported) {
                // Parse or validation failures, or a request-level error for this operation.
                await didEncounterErrors(state, singleResult.errors);
                if (!requestContext.response.http.status && !requestContext.document) {
                    // Apollo's SyntaxError / ValidationError carry a 400 status.
                    requestContext.response.http.status = 400;
                }
            }
            (requestContext.response as any).body = { kind: 'single', singleResult };
            await Promise.all(listeners.map(l => l.willSendResponse?.(requestContext as any)));
            const body = (requestContext.response as any).body;
            const finalResult: ExecutionResult = body?.kind === 'single' ? body.singleResult : singleResult;
            setResult(finalizeHttp(state, finalResult));
        },

        async onResultProcess({ result, serverContext }) {
            if (plugins.length === 0 || stateByContext.has(serverContext)) {
                return;
            }
            // No operation ever started for this request (e.g. the body could not be parsed, or a
            // request-level check rejected it). Apollo reports these via `invalidRequestWasReceived`.
            const errors = !Array.isArray(result) && !isAsyncIterable(result) ? result.errors : undefined;
            if (errors?.length) {
                const error = errors[0] as unknown as Error;
                await Promise.all(plugins.map(p => p.invalidRequestWasReceived?.({ error })));
            }
        },
    };

    function wrapIncrementalResult(
        iterable: AsyncIterable<ExecutionResult>,
        state: OperationState,
    ): AsyncIterable<ExecutionResult> {
        const { requestContext, listeners } = state;
        return {
            [Symbol.asyncIterator]() {
                const iterator = iterable[Symbol.asyncIterator]();
                let first = true;
                const subsequentResults: ExecutionResult[] = [];
                return {
                    async next() {
                        const next = await iterator.next();
                        if (next.done) {
                            return next;
                        }
                        if (first) {
                            first = false;
                            if (next.value.errors?.length) {
                                await didEncounterErrors(state, next.value.errors);
                            }
                            (requestContext.response as any).body = {
                                kind: 'incremental',
                                initialResult: next.value,
                                subsequentResults: (async function* () {
                                    yield* subsequentResults;
                                })(),
                            };
                            await Promise.all(listeners.map(l => l.willSendResponse?.(requestContext as any)));
                        } else {
                            if (next.value.errors?.length) {
                                await Promise.all(
                                    listeners.map(l =>
                                        l.didEncounterSubsequentErrors?.(
                                            requestContext as any,
                                            next.value.errors as readonly GraphQLError[],
                                        ),
                                    ),
                                );
                            }
                            await Promise.all(
                                listeners.map(l =>
                                    l.willSendSubsequentPayload?.(requestContext as any, next.value as any),
                                ),
                            );
                        }
                        return next;
                    },
                    return: iterator.return?.bind(iterator),
                    throw: iterator.throw?.bind(iterator),
                };
            },
        };
    }
}

function requestHeaderEntries(request: Request): Array<[string, string]> {
    const entries: Array<[string, string]> = [];
    request.headers.forEach((value, key) => entries.push([key, value]));
    return entries;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<any> {
    return !!value && typeof (value as any)[Symbol.asyncIterator] === 'function';
}

export type { ApolloServerPlugin, GraphQLRequestContext, GraphQLRequestListener };
