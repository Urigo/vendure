import { GraphQLError } from 'graphql';
import { Plugin } from 'graphql-yoga';

import { getOriginalRequestHeaders } from './original-request-headers';
import { ApolloErrorCode } from './use-apollo-compatible-errors';

/**
 * Mirrors Apollo Server's `CSRFPreventionOptions` so that existing `apiOptions.csrfPrevention`
 * configuration keeps working unchanged.
 *
 * @docsCategory configuration
 * @docsPage ApiOptions
 * @since 3.9.0
 */
export interface CsrfPreventionOptions {
    /**
     * @description
     * The request headers whose presence (with a non-empty value) marks a request as having
     * gone through a CORS preflight, which lets it bypass the content-type check.
     *
     * @default ['x-apollo-operation-name', 'apollo-require-preflight']
     */
    requestHeaders?: string[];
}

/**
 * The headers Apollo Server accepts by default. Every Vendure client (`@vendure/admin-ui`,
 * `@vendure/dashboard`, `@vendure/testing`) sends `Apollo-Require-Preflight: true`, and the
 * Apollo Client ecosystem sends `x-apollo-operation-name`, so these stay the defaults.
 */
export const recommendedCsrfPreventionRequestHeaders = [
    'x-apollo-operation-name',
    'apollo-require-preflight',
];

/**
 * Content types which a browser lets an HTML form or a "simple" `fetch` send cross-origin
 * without a CORS preflight.
 */
const NON_PREFLIGHTED_CONTENT_TYPES = [
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    'text/plain',
];

/**
 * A Yoga plugin which reproduces Apollo Server's `csrfPrevention` feature exactly: the same
 * blocked content types, the same bypass headers, the same HTTP 400 `BAD_REQUEST` response
 * and the same message, so that the documented behaviour of `apiOptions.csrfPrevention`
 * (and the clients built against it) is unchanged.
 *
 * Yoga's own `@graphql-yoga/plugin-csrf-prevention` implements the same idea but with a
 * different header (`x-graphql-yoga-csrf`), status (403) and message, which would be a
 * breaking change for Vendure clients.
 *
 * The check reads the headers *as the client sent them* (see {@link ORIGINAL_REQUEST_HEADERS}),
 * because a body which Express middleware has already parsed (e.g. `graphql-upload`'s multipart
 * handling) is presented to Yoga as `application/json`.
 */
export function useCsrfPrevention(options: true | CsrfPreventionOptions): Plugin {
    const requestHeaders =
        typeof options === 'object' && options.requestHeaders
            ? options.requestHeaders
            : recommendedCsrfPreventionRequestHeaders;

    return {
        onRequestParse({ request, serverContext }) {
            const getHeader = getOriginalRequestHeaders(serverContext, request);
            const contentType = getHeader('content-type');
            if (contentType !== undefined) {
                const essence = parseMediaTypeEssence(contentType);
                if (essence === null) {
                    // Unparseable content type: Apollo lets the request through to be rejected
                    // (or not) by the body parser.
                    return;
                }
                if (!NON_PREFLIGHTED_CONTENT_TYPES.includes(essence)) {
                    return;
                }
            }
            if (
                requestHeaders.some(header => {
                    const value = getHeader(header);
                    return value !== undefined && value.length > 0;
                })
            ) {
                return;
            }
            throw new GraphQLError(
                `This operation has been blocked as a potential Cross-Site Request Forgery ` +
                    `(CSRF). Please either specify a 'content-type' header (with a type that ` +
                    `is not one of ${NON_PREFLIGHTED_CONTENT_TYPES.join(', ')}) or provide ` +
                    `a non-empty value for one of the following headers: ${requestHeaders.join(', ')}\n`,
                { extensions: { code: ApolloErrorCode.BAD_REQUEST, http: { status: 400 } } },
            );
        },
    };
}

/**
 * Returns the `type/subtype` part of a media type, lower-cased, or `null` when the header
 * is not a valid media type (following the WHATWG MIME Sniffing "parse a MIME type" rules
 * which Apollo applies via `whatwg-mimetype`).
 */
function parseMediaTypeEssence(contentType: string): string | null {
    const essence = contentType.split(';')[0].trim().toLowerCase();
    const slash = essence.indexOf('/');
    if (slash <= 0 || slash === essence.length - 1) {
        return null;
    }
    const type = essence.slice(0, slash);
    const subtype = essence.slice(slash + 1);
    const token = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
    if (!token.test(type) || !token.test(subtype)) {
        return null;
    }
    return essence;
}
