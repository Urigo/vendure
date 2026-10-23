import { getOperationAST, GraphQLError, GraphQLErrorExtensions } from 'graphql';
import { handleStreamOrSingleExecutionResult, Plugin } from 'graphql-yoga';

import { isBadUserInputGraphQLError } from '../apollo-server-plugin-compat/apollo-request-context';

/**
 * The `extensions.code` values which Apollo Server attaches to errors it raises itself
 * (`ApolloServerErrorCode`), and which clients such as `@vendure/admin-ui` and storefronts
 * built on Apollo Client have come to rely on.
 */
export const ApolloErrorCode = {
    INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
    GRAPHQL_PARSE_FAILED: 'GRAPHQL_PARSE_FAILED',
    GRAPHQL_VALIDATION_FAILED: 'GRAPHQL_VALIDATION_FAILED',
    BAD_USER_INPUT: 'BAD_USER_INPUT',
    BAD_REQUEST: 'BAD_REQUEST',
    OPERATION_RESOLUTION_FAILURE: 'OPERATION_RESOLUTION_FAILURE',
} as const;

/**
 * Nest's `@nestjs/apollo` driver mapped NestJS `HttpException`s onto these codes.
 */
const nestHttpStatusToCode: Record<number, string> = {
    400: ApolloErrorCode.BAD_REQUEST,
    422: ApolloErrorCode.BAD_USER_INPUT,
    401: 'UNAUTHENTICATED',
    403: 'FORBIDDEN',
};

/**
 * Reproduces the error-response conventions of Apollo Server 5 (as it was wired up by
 * `@nestjs/apollo`) on top of GraphQL Yoga, so that the shape of error responses does not change
 * for API clients when the server is swapped:
 *
 * - Every error carries an `extensions.code`; errors without one get `INTERNAL_SERVER_ERROR`.
 * - Syntax errors are `GRAPHQL_PARSE_FAILED` and validation errors are
 *   `GRAPHQL_VALIDATION_FAILED`, both served with HTTP 400.
 * - Variable coercion errors are `BAD_USER_INPUT`, served with HTTP 400 (Apollo Server 5's
 *   `status400ForVariableCoercionErrors` default, which Vendure adopted in v3.8).
 * - A request whose operation cannot be resolved is `OPERATION_RESOLUTION_FAILURE` / 400.
 * - Request-level rejections (invalid JSON, missing query, ...) are `BAD_REQUEST`.
 * - NestJS `HttpException`s thrown from resolvers map to codes by status and expose the exception
 *   response as `extensions.originalError`, exactly like `@nestjs/apollo` did.
 *
 * Stack traces are never included: Yoga does not add `extensions.stacktrace`, which is the
 * behaviour Vendure already enforced with `includeStacktraceInErrorResponses: false`.
 */
export function useApolloCompatibleErrors(): Plugin {
    return {
        onParse() {
            return ({ result, replaceParseResult }) => {
                if (result instanceof GraphQLError) {
                    replaceParseResult(withCode(result, ApolloErrorCode.GRAPHQL_PARSE_FAILED, 400));
                }
            };
        },
        onValidate() {
            return ({ valid, result, setResult }) => {
                if (!valid) {
                    setResult(
                        result.map(error =>
                            error instanceof GraphQLError
                                ? withCode(error, ApolloErrorCode.GRAPHQL_VALIDATION_FAILED, 400)
                                : error,
                        ),
                    );
                }
            };
        },
        onExecute({ args }) {
            return {
                onExecuteDone(payload) {
                    return handleStreamOrSingleExecutionResult(payload, ({ result, setResult }) => {
                        if (!result.errors?.length) {
                            return;
                        }
                        const operationResolved = !!getOperationAST(args.document, args.operationName);
                        let status: number | undefined;
                        const errors = result.errors.map(error => {
                            const code = error.extensions?.code;
                            if (code != null) {
                                return applyNestHttpException(error);
                            }
                            if (!operationResolved) {
                                status = 400;
                                return withCode(error, ApolloErrorCode.OPERATION_RESOLUTION_FAILURE, 400);
                            }
                            if (isBadUserInputGraphQLError(error)) {
                                if (result.data === undefined) {
                                    status = 400;
                                }
                                return withCode(error, ApolloErrorCode.BAD_USER_INPUT);
                            }
                            return applyNestHttpException(
                                withCode(error, ApolloErrorCode.INTERNAL_SERVER_ERROR),
                            );
                        });
                        setResult({
                            ...result,
                            errors,
                            ...(status
                                ? { extensions: { ...result.extensions, http: { status } } }
                                : {}),
                        } as typeof result);
                    });
                },
            };
        },
        onResultProcess({ result, setResult }) {
            // Request-level errors never pass through parse/validate/execute, so give them a code too.
            if (Array.isArray(result) || isAsyncIterable(result) || !result.errors?.length) {
                return;
            }
            let changed = false;
            const errors = result.errors.map(error => {
                if (error.extensions?.code != null) {
                    return error;
                }
                changed = true;
                const http = error.extensions?.http as { status?: number } | undefined;
                const code =
                    http?.status && http.status >= 400 && http.status < 500
                        ? ApolloErrorCode.BAD_REQUEST
                        : ApolloErrorCode.INTERNAL_SERVER_ERROR;
                return withCode(error, code);
            });
            if (changed) {
                setResult({ ...result, errors } as typeof result);
            }
        },
    };
}

/**
 * Sets `extensions.code` (and optionally the HTTP status Yoga should respond with) on an error
 * without discarding anything else about it. `GraphQLError.extensions` is a plain object which
 * graphql-js allows to be mutated; Yoga strips `extensions.http` before serializing.
 */
function withCode(error: GraphQLError, code: string, status?: number): GraphQLError {
    const extensions = error.extensions as GraphQLErrorExtensions & Record<string, unknown>;
    if (extensions.code == null) {
        extensions.code = code;
    }
    if (status) {
        const http = (extensions.http ??= {}) as { status?: number };
        http.status ??= status;
    }
    return error;
}

/**
 * Port of `@nestjs/apollo`'s `createTransformHttpErrorFn()`.
 */
function applyNestHttpException(error: GraphQLError): GraphQLError {
    const exceptionRef = unwrapResolverError(error);
    const isHttpException = exceptionRef?.response?.statusCode && exceptionRef?.status;
    if (!isHttpException) {
        return error;
    }
    const extensions = error.extensions as GraphQLErrorExtensions & Record<string, unknown>;
    const httpStatus: number = exceptionRef.status;
    extensions.code = nestHttpStatusToCode[httpStatus] ?? ApolloErrorCode.INTERNAL_SERVER_ERROR;
    if (!(httpStatus in nestHttpStatusToCode)) {
        extensions.status = httpStatus;
    }
    extensions.originalError = exceptionRef.response;
    return error;
}

function unwrapResolverError(error: GraphQLError): any {
    return error.originalError ?? error;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
    return !!value && typeof (value as any)[Symbol.asyncIterator] === 'function';
}
