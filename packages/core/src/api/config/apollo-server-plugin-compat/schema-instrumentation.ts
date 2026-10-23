/**
 * Port of Apollo Server's `utils/schemaInstrumentation.ts`.
 *
 * Apollo Server implements the `executionDidStart().willResolveField()` plugin hook by wrapping
 * every field resolver of the schema (once, lazily, the first time a plugin asks for it) and
 * dispatching to a per-request function stored on the GraphQL context under a well-known
 * symbol. This file reproduces that mechanism so that plugins which rely on per-field timing
 * (tracing, usage reporting, custom profilers) behave identically under Yoga.
 */
import { defaultFieldResolver, getNamedType, GraphQLField, GraphQLObjectType, GraphQLSchema } from 'graphql';

export const symbolExecutionDispatcherWillResolveField = Symbol('apolloServerExecutionDispatcherWillResolveField');
export const symbolUserFieldResolver = Symbol('apolloServerUserFieldResolver');
const symbolPluginsEnabled = Symbol('apolloServerPluginsEnabled');

export function enablePluginsForSchemaResolvers(schema: GraphQLSchema): GraphQLSchema {
    if (pluginsEnabledForSchemaResolvers(schema)) {
        return schema;
    }
    Object.defineProperty(schema, symbolPluginsEnabled, { value: true });
    for (const type of Object.values(schema.getTypeMap())) {
        if (!getNamedType(type).name.startsWith('__') && type instanceof GraphQLObjectType) {
            for (const field of Object.values(type.getFields())) {
                wrapField(field);
            }
        }
    }
    return schema;
}

export function pluginsEnabledForSchemaResolvers(schema: GraphQLSchema): boolean {
    return !!(schema as any)[symbolPluginsEnabled];
}

function wrapField(field: GraphQLField<any, any>): void {
    const originalFieldResolve = field.resolve;
    field.resolve = (source, args, contextValue, info) => {
        const willResolveField = contextValue?.[symbolExecutionDispatcherWillResolveField];
        const userFieldResolver = contextValue?.[symbolUserFieldResolver];
        const didResolveField =
            typeof willResolveField === 'function' && willResolveField({ source, args, contextValue, info });
        const fieldResolver = originalFieldResolve || userFieldResolver || defaultFieldResolver;
        try {
            const result = fieldResolver(source, args, contextValue, info);
            if (typeof didResolveField === 'function') {
                whenResultIsFinished(result, didResolveField);
            }
            return result;
        } catch (error) {
            if (typeof didResolveField === 'function') {
                didResolveField(error);
            }
            throw error;
        }
    };
}

function isPromise(x: any): x is Promise<any> {
    return x && typeof x.then === 'function';
}

export function whenResultIsFinished(result: any, callback: (err: Error | null, result?: any) => void): void {
    if (isPromise(result)) {
        result.then(
            r => whenResultIsFinished(r, callback),
            err => callback(err),
        );
    } else if (Array.isArray(result)) {
        if (result.some(isPromise)) {
            Promise.all(result).then(
                r => callback(null, r),
                err => callback(err),
            );
        } else {
            callback(null, result);
        }
    } else {
        callback(null, result);
    }
}
