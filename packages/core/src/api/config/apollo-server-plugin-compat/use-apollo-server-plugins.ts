/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/await-thenable, @typescript-eslint/unbound-method, @typescript-eslint/require-await */
// The disabled rules above are triggered by the faithful port of Apollo Server's request pipeline,
// which awaits `Promise.all()` over optional plugin hooks that may return `undefined`.
import type {
    ApolloServerPlugin,
    GraphQLRequestContext,
    GraphQLRequestExecutionListener,
    GraphQLRequestListener,
    GraphQLResponse,
    GraphQLServerListener,
} from '@apollo/server';
import {
    DocumentNode,
    ExecutionResult,
    getOperationAST,
    GraphQLError,
    GraphQLFormattedError,
    GraphQLSchema,
} from 'graphql';
import type { Plugin as YogaPlugin } from 'graphql-yoga';

import type { ApolloConfig } from './apollo-default-plugins';
import {
    computeQueryHash,
    ensureGraphQLError,
    HeaderMap,
    InMemoryKeyValueCache,
    invokeDidStartHook,
    invokeHooksUntilDefinedAndNonNull,
    invokeSyncDidStartHook,
    isBadUserInputGraphQLError,
    isGraphQLErrorLike,
    newCachePolicy,
} from './apollo-request-context';
import {
    enablePluginsForSchemaResolvers,
    symbolExecutionDispatcherWillResolveField,
} from './schema-instrumentation';

/**
 * @description
 * Options for {@link useApolloServerPlugins} and {@link createApolloServerPluginsCompat}.
 */
export interface ApolloServerPluginCompatOptions {
    /**
     * @description
     * The Apollo Server plugins to run. Plugins run in array order, exactly as Apollo Server runs
     * them: `requestDidStart` is awaited for all plugins before the request proceeds, and the
     * `*DidEnd` callbacks run in reverse order.
     *
     * Note that Apollo Server also installs some plugins implicitly (e.g. cache control); use
     * {@link withApolloServerDefaultPlugins} to get the same list Apollo Server would run.
     */
    plugins: Array<ApolloServerPlugin<any>>;
    /**
     * @description
     * The logger exposed as `requestContext.logger` / `GraphQLServerContext.logger`.
     * Defaults to the request-scoped Yoga logger.
     */
    logger?: ApolloLogger;
    /**
     * @description
     * The value of `GraphQLServerContext.apollo` (Apollo key, graph ref), which e.g. the usage
     * reporting plugin reads. See {@link determineApolloConfig}.
     */
    apollo?: ApolloConfig;
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

/**
 * @description
 * The two halves of the compatibility layer, plus a startup barrier.
 *
 * Apollo Server reports execution errors to `didEncounterErrors` *before* it formats them
 * (assigning `extensions.code`), and it formats them *before* `willSendResponse`. Yoga plugins
 * which shape errors or the result sit between those two points, so the compatibility layer is
 * split in two:
 *
 * - `early` must be registered before any plugin which rewrites execution errors or results;
 * - `late` must be registered after them.
 *
 * {@link useApolloServerPlugins} merges both into a single plugin for setups that have no such
 * plugins.
 */
export interface ApolloServerPluginsCompat {
    early: YogaPlugin;
    late: YogaPlugin;
    /**
     * Resolves once every plugin's `serverWillStart` has completed, and rejects with the error of a
     * failing one (after calling `startupDidFail`), mirroring `ApolloServer.start()`. A host should
     * await it before it starts serving requests.
     */
    ready(): Promise<void>;
}

/**
 * Plugins created by this module carry a reference to their startup barrier under this symbol, so
 * that a host can await it without knowing which plugins came from where.
 */
export const APOLLO_SERVER_PLUGINS_READY = Symbol.for('vendure.apolloServerPluginsReady');

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
    /** Resolves once `didResolveSource` and every `parsingDidEnd` callback has run. */
    parsingDone?: Promise<void>;
    /** Resolves once every `validationDidEnd` callback has run. */
    validationDone?: Promise<void>;
    /** `didEncounterErrors` has already been invoked for the errors currently on the context. */
    errorsReported: boolean;
    /** `executionDidStart` listeners have been resolved and `executionDidEnd` has been invoked. */
    executionEnded: boolean;
    /** A plugin's `responseForOperation` short-circuited execution. */
    responseFromPlugin: boolean;
    /** The request reached the execution phase (as opposed to failing in parse/validate). */
    executionStarted: boolean;
    /** `willSendResponse` has been invoked for this operation. */
    responseSent: boolean;
    /** The document was found in the (emulated) document store, so it is not parsed or validated. */
    documentFromStore: boolean;
}

/** Apollo's default document store is a size-bounded LRU cache; this bounds the emulation. */
const MAX_REMEMBERED_DOCUMENTS = 10_000;

const stateByContext = new WeakMap<object, OperationState>();
const stateByRequest = new WeakMap<object, OperationState>();
const batchedByServerContext = new WeakMap<object, boolean>();

/**
 * @description
 * Creates the Yoga plugins which run [Apollo Server plugins](https://www.apollographql.com/docs/apollo-server/integrations/plugins/)
 * on GraphQL Yoga, mapping Apollo's request-lifecycle hooks onto Yoga's.
 *
 * It exists so that code written against the `ApolloServerPlugin` interface keeps working
 * unchanged after the server underneath has been swapped from Apollo Server to Yoga. The
 * `GraphQLRequestContext` handed to plugins is a faithful reproduction of Apollo's: the same
 * properties, the same mutability (`response.body.singleResult.data|errors`,
 * `response.http.status|headers`), the same ordering rules, and the same behaviour when a hook
 * throws. `apollo-parity.spec.ts` verifies this against a real `ApolloServer`.
 *
 * ## Hook mapping
 *
 * | Apollo Server hook                                 | Yoga / Envelop hook                                          |
 * |----------------------------------------------------|--------------------------------------------------------------|
 * | `serverWillStart`                                  | first `onSchemaChange` (awaited through `ready()`)           |
 * | `GraphQLServerListener.schemaDidLoadOrUpdate`      | subsequent `onSchemaChange`                                  |
 * | `GraphQLServerListener.serverWillStop/drainServer` | `onDispose` (`yoga.dispose()`)                               |
 * | `requestDidStart`                                  | `onParams` (before persisted queries are resolved)           |
 * | `didResolveSource`, `parsingDidStart` → `End`      | `onParse` → after-parse                                      |
 * | `validationDidStart` → `validationDidEnd`          | `onValidate` → after-validate                                |
 * | `didResolveOperation`, `responseForOperation`      | `onExecute` (before execution)                               |
 * | `executionDidStart` → `executionDidEnd`            | `onExecute` → `onExecuteDone`                                |
 * | `willResolveField`                                 | schema resolver instrumentation (identical to Apollo)        |
 * | `didEncounterErrors`                               | `onExecuteDone` / `onExecutionResult` / `onResultProcess`    |
 * | `willSendResponse`                                 | `onExecutionResult` / `onResultProcess`                      |
 * | `willSendSubsequentPayload`                        | `onExecutionResult` (streamed results)                       |
 * | `invalidRequestWasReceived`                        | `onResultProcess` (request rejected before any operation ran) |
 *
 * ## Known differences
 *
 * - `parsingDidStart` and `validationDidStart` are invoked synchronously (Envelop's parse and
 *   validate hooks are synchronous); their returned `*DidEnd` callbacks are awaited before
 *   `didResolveOperation` runs, so timing plugins see the same sequence of events.
 * - `GraphQLServerListener.renderLandingPage` is ignored: Yoga serves its own GraphiQL.
 * - `requestContext.cache` is a small in-memory cache rather than Apollo's `InMemoryLRUCache`.
 * - When the operation to run cannot be determined, Yoga rejects the request right after parsing,
 *   so the validation and execution hooks are not invoked (same status and error code).
 */
export function createApolloServerPluginsCompat(
    options: ApolloServerPluginCompatOptions,
): ApolloServerPluginsCompat {
    const { plugins } = options;
    const cache = new InMemoryKeyValueCache();
    let serverListeners: Promise<GraphQLServerListener[]> | undefined;
    let currentSchema: GraphQLSchema | undefined;
    // Apollo Server keeps parsed-and-validated documents in a "document store" and does not invoke
    // `parsingDidStart` / `validationDidStart` for a query whose document it already has. Yoga has
    // its own parse/validate cache, so only the set of known query hashes needs to be emulated.
    let validatedQueryHashes = new Map<string, true>();
    const rememberValidated = (queryHash: string | undefined) => {
        if (!queryHash) {
            return;
        }
        validatedQueryHashes.set(queryHash, true);
        if (validatedQueryHashes.size > MAX_REMEMBERED_DOCUMENTS) {
            validatedQueryHashes.delete(validatedQueryHashes.keys().next().value as string);
        }
    };
    let signalStarted: (listeners: Promise<GraphQLServerListener[]>) => void = () => undefined;
    const started = new Promise<Promise<GraphQLServerListener[]>>(resolve => (signalStarted = resolve));

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
        for (const [key, value] of options.getRequestHeaders?.(context, request) ??
            requestHeaderEntries(request)) {
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

    /**
     * Runs Apollo's response phase for a single result: reports errors which have not been
     * reported yet, formats the errors as Apollo does (fresh plain objects, `extensions.code` set,
     * `extensions.http` moved into `response.http`), calls `willSendResponse`, and returns the result
     * to send, with the final status and headers attached for Yoga.
     */
    async function sendResponse(state: OperationState, result: ExecutionResult): Promise<ExecutionResult> {
        const { requestContext, listeners } = state;
        state.responseSent = true;
        let errors = result.errors;
        if (errors?.length && !state.errorsReported) {
            // Parse or validation failures, or a request-level error. Yoga caches parse and
            // validation results, errors included, so plugins get copies of their own.
            errors = errors.map(error => cloneError(error));
            await didEncounterErrors(state, errors);
        }
        const http = requestContext.response.http;
        if (errors?.length) {
            mergeHttpFromErrors(http, errors);
            if (!state.executionStarted && !http.status) {
                // Apollo's SyntaxError / ValidationError carry a 400 status.
                http.status = 400;
            }
        }
        const singleResult: ExecutionResult = errors?.length
            ? { ...result, errors: errors.map(e => formatError(e)) as any }
            : result;
        (requestContext.response as any).body = { kind: 'single', singleResult };
        await Promise.all(listeners.map(l => l.willSendResponse?.(requestContext as any)));
        const body = (requestContext.response as any).body;
        const finalResult: ExecutionResult = body?.kind === 'single' ? body.singleResult : singleResult;
        // Errors which plugins put on the response in `willSendResponse` are sent as the plugin
        // built them (Apollo formats before that hook); only `extensions.http` is dropped so that
        // the status decided above stands.
        return withHttp(
            finalResult.errors?.length
                ? { ...finalResult, errors: finalResult.errors.map(e => formatError(e, false)) as any }
                : finalResult,
            http,
        );
    }

    const early: YogaPlugin = {
        onSchemaChange({ schema }) {
            currentSchema = schema;
            validatedQueryHashes = new Map();
            if (!serverListeners) {
                const service = {
                    logger: fallbackLogger,
                    cache,
                    schema,
                    apollo: options.apollo ?? {},
                    startedInBackground: false,
                };
                serverListeners = Promise.all(plugins.map(p => p.serverWillStart?.(service as any))).then(
                    listeners => listeners.filter((l): l is GraphQLServerListener => !!l),
                    async error => {
                        await Promise.all(plugins.map(p => p.startupDidFail?.({ error })));
                        throw error;
                    },
                );
                serverListeners.catch(() => undefined);
                signalStarted(serverListeners);
            } else {
                void serverListeners
                    .then(listeners =>
                        listeners.forEach(l => l.schemaDidLoadOrUpdate?.({ apiSchema: schema })),
                    )
                    .catch(() => undefined);
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
            // Apollo Server does not process requests before `start()` has completed.
            await serverListeners;
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
                requestIsBatched:
                    batchedByServerContext.get(Object.getPrototypeOf(context) ?? context) ??
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
                executionStarted: false,
                responseSent: false,
                documentFromStore: false,
            };
            stateByContext.set(context, state);
            stateByRequest.set(request, state);
            state.listeners = (
                await Promise.all(plugins.map(p => p.requestDidStart?.(requestContext as any)))
            ).filter((l): l is RequestListener => !!l);
        },

        onParse({ context, params }) {
            const state = stateByContext.get(context);
            if (!state || state.listeners.length === 0) {
                return;
            }
            const { requestContext, listeners } = state;
            // The source is only known here: an Automatic Persisted Query is resolved after
            // `requestDidStart`, exactly as in Apollo Server.
            const source = typeof params.source === 'string' ? params.source : params.source.body;
            requestContext.request.query = source;
            requestContext.source = source;
            requestContext.queryHash = computeQueryHash(source);
            const sourceResolved = Promise.all(
                listeners.map(l => l.didResolveSource?.(requestContext as any)),
            );
            if (validatedQueryHashes.has(requestContext.queryHash)) {
                state.documentFromStore = true;
                state.parsingDone = sourceResolved.then(() => undefined);
                state.parsingDone.catch(() => undefined);
                return ({ result }) => {
                    if (!(result instanceof Error)) {
                        requestContext.document = result as DocumentNode;
                    }
                };
            }
            const parsingDidEnd = sourceResolved.then(() =>
                invokeDidStartHook(listeners, l => l.parsingDidStart?.(requestContext as any)),
            );
            return ({ result }) => {
                if (result instanceof Error) {
                    state.parsingDone = parsingDidEnd.then(end => end(result));
                } else {
                    requestContext.document = result as DocumentNode;
                    state.parsingDone = parsingDidEnd.then(end => end());
                }
                state.parsingDone.catch(() => undefined);
            };
        },

        onValidate({ context }) {
            const state = stateByContext.get(context);
            if (!state || state.listeners.length === 0 || state.documentFromStore) {
                return;
            }
            // Wait for the parsing phase to have fully reported before announcing validation, so
            // that `validationDidStart` is observed after `parsingDidEnd` as in Apollo Server.
            const validationDidEnd = (state.parsingDone ?? Promise.resolve()).then(() =>
                invokeDidStartHook(state.listeners, l => l.validationDidStart?.(state.requestContext as any)),
            );
            return ({ valid, result }) => {
                if (valid) {
                    rememberValidated(state.requestContext.queryHash);
                }
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
            state.executionStarted = true;
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

            const responseFromPlugin = await invokeHooksUntilDefinedAndNonNull<
                RequestListener,
                GraphQLResponse
            >(listeners, async l => (await l.responseForOperation?.(requestContext as any)) ?? null);
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
                    setResultAndStopExecution(responseFromPlugin.body.singleResult);
                } else {
                    setResultAndStopExecution(responseFromPlugin.body.initialResult);
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
                        // Reported before any other plugin has touched the errors, as in Apollo,
                        // except that variable coercion errors are Apollo's `UserInputError`s.
                        await didEncounterErrors(state, result.errors.map(asApolloExecutionError));
                        applyHttpFromExecutionResult(state, result);
                    }
                    state.executionEnded = true;
                    await Promise.all(state.executionListeners.map(l => l.executionDidEnd?.()));
                },
            };
        },
    };

    const late: YogaPlugin = {
        async onExecutionResult({ result, setResult, context }) {
            const state = stateByContext.get(context);
            if (!state || state.listeners.length === 0) {
                return;
            }
            // When parse or validation failed, execution never ran, so make sure their *DidEnd
            // callbacks have been reported before `didEncounterErrors` / `willSendResponse`.
            await state.parsingDone;
            await state.validationDone;

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

            setResult(await sendResponse(state, result as ExecutionResult));
        },

        async onResultProcess({ request, result, setResult }) {
            if (plugins.length === 0 || Array.isArray(result) || isAsyncIterable(result)) {
                return;
            }
            const state = stateByRequest.get(request);
            if (state && !state.responseSent && state.listeners.length) {
                // The request was rejected after `requestDidStart`, before an operation ran (e.g. a
                // persisted query that is not in the cache): Apollo's `sendErrorResponse()` path.
                setResult(await sendResponse(state, result));
                return;
            }
            if (!state && result.errors?.length) {
                // No operation ever started for this request (e.g. the body could not be parsed).
                // Apollo reports these via `invalidRequestWasReceived`.
                const error = result.errors[0] as unknown as Error;
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
                            state.responseSent = true;
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
                            await Promise.all(
                                listeners.map(l => l.willSendResponse?.(requestContext as any)),
                            );
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

    const ready = async () => {
        if (plugins.length === 0) {
            return;
        }
        await await started;
    };
    (early as any)[APOLLO_SERVER_PLUGINS_READY] = ready;
    return { early, late, ready };
}

/**
 * @description
 * A single Yoga plugin which runs [Apollo Server plugins](https://www.apollographql.com/docs/apollo-server/integrations/plugins/)
 * on GraphQL Yoga. It combines both halves of {@link createApolloServerPluginsCompat}; use that
 * instead when other Yoga plugins rewrite execution errors or results, so that Apollo plugins see
 * them at the same points as on Apollo Server.
 *
 * @example
 * ```ts
 * import { createYoga } from 'graphql-yoga';
 *
 * const yoga = createYoga({
 *   schema,
 *   plugins: [useApolloServerPlugins({ plugins: [myExistingApolloPlugin] })],
 * });
 * ```
 */
export function useApolloServerPlugins(options: ApolloServerPluginCompatOptions): YogaPlugin {
    const { early, late, ready } = createApolloServerPluginsCompat(options);
    const plugin: YogaPlugin = { ...early, ...late };
    (plugin as any)[APOLLO_SERVER_PLUGINS_READY] = ready;
    return plugin;
}

/**
 * Apollo turns variable coercion errors into `UserInputError`s (code `BAD_USER_INPUT`) before
 * reporting them to `didEncounterErrors`.
 */
function asApolloExecutionError(error: GraphQLError): GraphQLError {
    if (isGraphQLErrorLike(error) && error.extensions?.code == null && isBadUserInputGraphQLError(error)) {
        return cloneError(error, { code: 'BAD_USER_INPUT' });
    }
    return error;
}

function cloneError(error: GraphQLError, extraExtensions?: Record<string, unknown>): GraphQLError {
    if (!isGraphQLErrorLike(error)) {
        return error;
    }
    return new GraphQLError(error.message, {
        nodes: error.nodes,
        source: error.source,
        positions: error.positions,
        path: error.path,
        originalError: error.originalError ?? undefined,
        extensions: { ...error.extensions, ...extraExtensions },
    });
}

/**
 * Port of Apollo Server's error formatting (`formatErrors()` without a custom `formatError`): each
 * error becomes a plain serialized object with an `extensions.code` (defaulting to
 * `INTERNAL_SERVER_ERROR`), and `extensions.http` is removed (it has been merged into the
 * response's HTTP head). Already-formatted errors are copied with `extensions.http` removed.
 */
function formatError(
    error: GraphQLError | GraphQLFormattedError,
    assignDefaultCode = true,
): GraphQLFormattedError {
    const formatted: GraphQLFormattedError =
        isGraphQLErrorLike(error) && typeof (error as any).toJSON === 'function'
            ? error.toJSON()
            : { ...(error as GraphQLFormattedError) };
    const isGraphQLError = isGraphQLErrorLike(error);
    if (formatted.extensions || isGraphQLError) {
        const { http, ...extensions } = (formatted.extensions ?? {}) as Record<string, unknown>;
        void http;
        if (assignDefaultCode && isGraphQLError && extensions.code == null) {
            extensions.code = 'INTERNAL_SERVER_ERROR';
        }
        if (Object.keys(extensions).length || (formatted.extensions && !http)) {
            (formatted as any).extensions = extensions;
        } else {
            delete (formatted as any).extensions;
        }
    }
    return formatted;
}

/**
 * Mirrors Apollo's `formatErrors()` → `mergeHTTPGraphQLHead()`: the HTTP status and headers which
 * errors carry in `extensions.http` are merged into the response's HTTP head; the last error with a
 * status wins.
 */
function mergeHttpFromErrors(
    http: { status?: number; headers: Map<string, string> },
    errors: ReadonlyArray<GraphQLError | GraphQLFormattedError>,
) {
    for (const error of errors) {
        const source = (error.extensions as any)?.http as
            | { status?: number; headers?: Record<string, string> | Map<string, string> }
            | undefined;
        if (source?.status) {
            http.status = source.status;
        }
        if (source?.headers) {
            const entries = source.headers instanceof Map ? source.headers : Object.entries(source.headers);
            for (const [key, value] of entries) {
                http.headers.set(key, value);
            }
        }
    }
}

/**
 * Mirrors what Apollo Server does with execution errors before `executionDidEnd`: a response with
 * errors but no `data` at all (i.e. variable coercion failed) gets a 400 status (Apollo Server 5's
 * `status400ForVariableCoercionErrors`, which defaults to `true`). The status and headers carried by
 * the errors themselves are merged when the response is formatted.
 */
function applyHttpFromExecutionResult(state: OperationState, result: ExecutionResult) {
    const http = state.requestContext.response.http;
    const errorWithStatus = result.errors?.some(e => (e.extensions?.http as any)?.status);
    if (!errorWithStatus && result.data === undefined && result.errors?.length && !http.status) {
        http.status = 400;
    }
}

/**
 * Attaches the final status and headers for Yoga. Apollo Server answers with 200 unless a status
 * was set, so the status is always made explicit.
 */
function withHttp(
    result: ExecutionResult,
    http: { status?: number; headers: Map<string, string> },
): ExecutionResult {
    const head: { status: number; headers?: Record<string, string> } = { status: http.status ?? 200 };
    if (http.headers.size) {
        head.headers = Object.fromEntries(http.headers);
    }
    return { ...result, extensions: { ...(result.extensions as object | undefined), http: head } };
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
