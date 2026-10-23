import { IncomingHttpHeaders } from 'http';

/**
 * Key under which {@link VendureYogaDriver} stores a snapshot of the incoming request headers
 * on the Express `req` object before handing the request to Yoga.
 *
 * This is needed because `@whatwg-node/server` passes `req.headers` by reference as the init
 * of the Fetch `Headers` it builds, and then *rewrites* `content-type` to `application/json`
 * whenever the body has already been parsed by Express middleware (as `graphql-upload` and
 * Nest's body parser do). `PonyfillHeaders.set()` writes through to the init object, so by the
 * time any Yoga plugin runs, `req.headers['content-type']` no longer reflects what the client
 * sent. CSRF prevention and the Apollo plugin compatibility layer both need the original value.
 */
export const ORIGINAL_REQUEST_HEADERS = Symbol.for('vendure.originalRequestHeaders');

export function snapshotRequestHeaders(req: { headers: IncomingHttpHeaders }): void {
    (req as any)[ORIGINAL_REQUEST_HEADERS] = { ...req.headers };
}

/**
 * Returns the headers as the client sent them, falling back to whatever the Fetch `Request`
 * reports when the request did not come through Express.
 */
export function getOriginalRequestHeaders(
    serverContext: any,
    request: Request,
): (name: string) => string | undefined {
    const nodeHeaders: IncomingHttpHeaders | undefined =
        serverContext?.req?.[ORIGINAL_REQUEST_HEADERS] ?? serverContext?.req?.headers;
    if (nodeHeaders && typeof nodeHeaders === 'object') {
        return name => {
            const value = nodeHeaders[name.toLowerCase()];
            if (value === undefined) {
                return undefined;
            }
            return Array.isArray(value) ? value.join(', ') : String(value);
        };
    }
    return name => request.headers.get(name) ?? undefined;
}

export function getOriginalRequestHeaderEntries(
    serverContext: any,
    request: Request,
): Array<[string, string]> {
    const nodeHeaders: IncomingHttpHeaders | undefined =
        serverContext?.req?.[ORIGINAL_REQUEST_HEADERS] ?? serverContext?.req?.headers;
    if (nodeHeaders && typeof nodeHeaders === 'object') {
        return Object.entries(nodeHeaders)
            .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
            .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]);
    }
    const entries: Array<[string, string]> = [];
    request.headers.forEach((value, key) => entries.push([key, value]));
    return entries;
}
