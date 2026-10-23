import { YogaDriver, YogaDriverConfig } from '@graphql-yoga/nestjs';
import { Injectable } from '@nestjs/common';
import type { Express } from 'express';

import { snapshotRequestHeaders } from './yoga-plugins/original-request-headers';

/**
 * The NestJS GraphQL driver used by Vendure: `@graphql-yoga/nestjs`'s `YogaDriver` plus two
 * Vendure-specific details:
 *
 * 1. A snapshot of each request's headers is taken before Yoga sees the request, so that plugins
 *    can read the `content-type` the client actually sent (see {@link ORIGINAL_REQUEST_HEADERS}).
 * 2. The Yoga instance is disposed when the Nest application shuts down, so that plugin
 *    `onDispose` hooks (and through them the `serverWillStop`/`drainServer` hooks of any Apollo
 *    Server plugins run via the compatibility layer) fire exactly once.
 */
@Injectable()
export class VendureYogaDriver extends YogaDriver<'express'> {
    protected override registerExpress(options: YogaDriverConfig<'express'>) {
        return super.registerExpress(options, {
            preStartHook: (app: Express) => {
                app.use(options.path ?? '/graphql', (req, _res, next) => {
                    snapshotRequestHeaders(req);
                    next();
                });
            },
        });
    }

    override async stop() {
        await super.stop();
        await this.yoga?.dispose?.();
    }
}
