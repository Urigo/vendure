import { Logger as YogaLogger } from 'graphql-yoga';

import { Logger } from '../../../config/logger/vendure-logger';

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
        // Everything from `debug` up is forwarded to the Vendure logger, which applies its own
        // configured log level on top.
        level: 'debug',
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
