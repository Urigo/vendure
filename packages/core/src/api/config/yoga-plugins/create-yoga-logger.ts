import { Logger as YogaLogger } from 'graphql-yoga';

import { Logger, LogLevel } from '../../../config/logger/vendure-logger';

const loggerCtx = 'GraphQL';

/**
 * Routes GraphQL Yoga's logging through the configured {@link VendureLogger}.
 *
 * Yoga emits one `info`-level "Request processed" line per request (its access log), which is
 * far chattier than what Vendure's `Info` level is used for, and Apollo Server never logged
 * per-request. That line is therefore mapped to Vendure's `Debug` level: operators who want an
 * access log can switch the Vendure logger to `LogLevel.Debug`, and everyone else sees the
 * same output as before. Warnings and errors from the server surface as before through the
 * Vendure logger.
 */
export function createYogaLogger(): YogaLogger {
    return new YogaLogger({
        // Evaluated lazily on every log call, so that Yoga skips building (and we skip formatting)
        // messages which the Vendure logger would discard anyway. Yoga logs at `debug` level on
        // every request, so this matters for throughput.
        level: () => yogaLevelFor(Logger.logger),
        writers: [
            {
                write(level, rawAttrs, msg) {
                    const attrs = Array.isArray(rawAttrs) ? { values: rawAttrs } : rawAttrs;
                    const message = formatMessage(attrs, msg);
                    switch (level) {
                        case 'error':
                            Logger.error(
                                message,
                                loggerCtx,
                                attrs?.err instanceof Error ? attrs.err.stack : undefined,
                            );
                            break;
                        case 'warn':
                            Logger.warn(message, loggerCtx);
                            break;
                        case 'info':
                        case 'debug':
                            Logger.debug(message, loggerCtx);
                            break;
                        default:
                            Logger.verbose(message, loggerCtx);
                    }
                },
            },
        ],
    });
}

/**
 * Maps the level of the active Vendure logger onto the minimum Yoga level worth producing.
 * Yoga's `info`/`debug` output is forwarded at Vendure's `Debug` level (see above), so it is only
 * produced when the Vendure logger would print it. Custom loggers which do not expose a numeric
 * `level` receive everything, as before.
 */
function yogaLevelFor(vendureLogger: unknown): 'debug' | 'warn' | 'error' {
    const level = (vendureLogger as { level?: unknown } | undefined)?.level;
    if (typeof level !== 'number') {
        return 'debug';
    }
    if (level >= LogLevel.Debug) {
        return 'debug';
    }
    return level >= LogLevel.Warn ? 'warn' : 'error';
}

function formatMessage(
    attrs: Record<string, unknown> | null | undefined,
    msg: string | null | undefined,
): string {
    if (!attrs || Object.keys(attrs).length === 0) {
        return msg ?? '';
    }
    const details = Object.entries(attrs)
        .filter(([key]) => key !== 'err')
        .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
        .join(' ');
    return msg ? `${msg} ${details}` : details;
}
