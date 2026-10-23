import { isObject } from '@vendure/common/lib/shared-utils';
import { DocumentNode, GraphQLSchema } from 'graphql';
import { handleStreamOrSingleExecutionResult, Plugin } from 'graphql-yoga';

import { ApiType } from '../common/get-api-type';
import { GraphqlValueTransformer } from '../common/graphql-value-transformer';
import { IdCodecService } from '../common/id-codec.service';

type OnExecuteHookResult = Awaited<ReturnType<NonNullable<Plugin['onExecute']>>>;

/**
 * Encodes the ids of outgoing responses according to the configured EntityIdStrategy.
 *
 * This is done here and not via a Nest Interceptor because it's not possible
 * according to https://github.com/nestjs/graphql/issues/320
 */
export class IdCodecPlugin implements Plugin {
    private graphqlValueTransformer: GraphqlValueTransformer;
    // Job ids only exist in the Admin API. A plugin could define its own `Job` type in the Shop API.
    private readonly transformJobIds: boolean;
    constructor(
        private idCodecService: IdCodecService,
        apiType: ApiType,
    ) {
        this.transformJobIds = apiType !== 'admin' || idCodecService.transformJobIds;
    }

    // Envelop invokes hooks detached from the plugin object, so they are bound arrow functions.
    onSchemaChange = ({ schema }: { schema: GraphQLSchema }) => {
        this.graphqlValueTransformer = new GraphqlValueTransformer(schema);
    };

    onExecute = (): OnExecuteHookResult => {
        return {
            onExecuteDone: payload =>
                handleStreamOrSingleExecutionResult(payload, ({ result, args }) => {
                    this.encodeIdFields(args.document, result.data as Record<string, unknown> | null | undefined);
                }),
        };
    };

    private encodeIdFields(document: DocumentNode, data?: Record<string, unknown> | null) {
        if (!data) {
            return;
        }
        const typeTree = this.graphqlValueTransformer.getOutputTypeTree(document);
        this.graphqlValueTransformer.transformValues(typeTree, data, (value, type, parentType) => {
            const isIdType = type && type.name === 'ID';
            if (isIdType && parentType?.name === 'Job' && !this.transformJobIds) {
                return value;
            }
            if (type && type.name === 'JSON' && isObject(value)) {
                return this.idCodecService.encode(value, [
                    'paymentId',
                    'fulfillmentId',
                    'orderItemIds',
                    'orderLineId',
                    'promotionId',
                    'refundId',
                    'groupId',
                    'modificationId',
                    'previousCustomerId',
                    'newCustomerId',
                ]);
            }
            return isIdType ? this.idCodecService.encode(value) : value;
        });
    }
}
