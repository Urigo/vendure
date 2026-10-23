import { DocumentNode, GraphQLNamedType, GraphQLSchema, isUnionType } from 'graphql';
import { handleStreamOrSingleExecutionResult, Plugin } from 'graphql-yoga';

import { Instrument } from '../../common/instrument-decorator';
import { AssetStorageStrategy } from '../../config/asset-storage-strategy/asset-storage-strategy';
import { ConfigService } from '../../config/config.service';
import { GraphqlValueTransformer } from '../common/graphql-value-transformer';

type OnExecuteHookResult = Awaited<ReturnType<NonNullable<Plugin['onExecute']>>>;

/**
 * Transforms outputs so that any Asset instances are run through the {@link AssetStorageStrategy.toAbsoluteUrl}
 * method before being returned in the response.
 */
@Instrument()
export class AssetInterceptorPlugin implements Plugin {
    private graphqlValueTransformer: GraphqlValueTransformer;
    private readonly toAbsoluteUrl: AssetStorageStrategy['toAbsoluteUrl'] | undefined;

    constructor(private configService: ConfigService) {
        const { assetOptions } = this.configService;
        if (assetOptions.assetStorageStrategy.toAbsoluteUrl) {
            this.toAbsoluteUrl = assetOptions.assetStorageStrategy.toAbsoluteUrl.bind(
                assetOptions.assetStorageStrategy,
            );
        }
    }

    // Envelop invokes hooks detached from the plugin object, so they are bound arrow functions.
    onSchemaChange = ({ schema }: { schema: GraphQLSchema }) => {
        this.graphqlValueTransformer = new GraphqlValueTransformer(schema);
    };

    onExecute = (): OnExecuteHookResult => {
        return {
            onExecuteDone: payload =>
                handleStreamOrSingleExecutionResult(payload, ({ result, args }) => {
                    if (result.data) {
                        const req = (args.contextValue as any)?.req;
                        this.prefixAssetUrls(req, args.document, result.data as Record<string, unknown>);
                    }
                }),
        };
    };

    private prefixAssetUrls(request: any, document: DocumentNode, data?: Record<string, unknown> | null) {
        const typeTree = this.graphqlValueTransformer.getOutputTypeTree(document);
        const toAbsoluteUrl = this.toAbsoluteUrl;
        if (!toAbsoluteUrl || !data) {
            return;
        }
        this.graphqlValueTransformer.transformValues(typeTree, data, (value, type) => {
            if (!type) {
                return value;
            }
            const isAssetType = this.isAssetType(type);
            const isUnionWithAssetType = isUnionType(type) && type.getTypes().find(t => this.isAssetType(t));
            if (isAssetType || isUnionWithAssetType) {
                if (value && !Array.isArray(value)) {
                    if (value.preview) {
                        value.preview = toAbsoluteUrl(request, value.preview);
                    }
                    if (value.source) {
                        value.source = toAbsoluteUrl(request, value.source);
                    }
                }
            }
            return value;
        });
    }

    private isAssetType(type: GraphQLNamedType): boolean {
        const assetTypeNames = ['Asset', 'SearchResultAsset'];
        return assetTypeNames.includes(type.name);
    }
}
