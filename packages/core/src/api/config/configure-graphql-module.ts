import { YogaDriverConfig } from '@graphql-yoga/nestjs';
import { useAPQ } from '@graphql-yoga/plugin-apq';
import { DynamicModule } from '@nestjs/common';
import { GraphQLModule, GraphQLTypesLoader } from '@nestjs/graphql';
import { GraphQLSchema, printSchema, ValidationContext, ValidationRule } from 'graphql';
import { Plugin as YogaPlugin } from 'graphql-yoga';

import { ConfigModule } from '../../config/config.module';
import { ConfigService } from '../../config/config.service';
import { I18nModule } from '../../i18n/i18n.module';
import { I18nService } from '../../i18n/i18n.service';
import { ServiceModule } from '../../service/service.module';
import { ApiSharedModule } from '../api-internal-modules';
import { CustomFieldRelationResolverService } from '../common/custom-field-relation-resolver.service';
import { IdCodecService } from '../common/id-codec.service';
import { AssetInterceptorPlugin } from '../middleware/asset-interceptor-plugin';
import { IdCodecPlugin } from '../middleware/id-codec-plugin';
import { TranslateErrorsPlugin } from '../middleware/translate-errors-plugin';

import { useApolloServerPlugins } from './apollo-server-plugin-compat';
import { generateResolvers } from './generate-resolvers';
import { getFinalVendureSchema, isUsingDefaultEntityIdStrategy } from './get-final-vendure-schema';
import { VendureYogaDriver } from './vendure-yoga-driver';
import { createYogaLogger } from './yoga-plugins/create-yoga-logger';
import { useApolloCompatibleErrors } from './yoga-plugins/use-apollo-compatible-errors';
import { getOriginalRequestHeaderEntries } from './yoga-plugins/original-request-headers';
import { useCsrfPrevention } from './yoga-plugins/use-csrf-prevention';
import { useValidationRules } from './yoga-plugins/use-validation-rules';

export interface GraphQLApiOptions {
    apiType: 'shop' | 'admin';
    typePaths: string[];
    apiPath: string;
    playground: boolean | Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    resolverModule: Function;
    validationRules: Array<(context: ValidationContext) => any>;
}

/**
 * Dynamically generates a GraphQLModule according to the given config options.
 */
export function configureGraphQLModule(
    getOptions: (configService: ConfigService) => GraphQLApiOptions,
): DynamicModule {
    return GraphQLModule.forRootAsync<YogaDriverConfig>({
        driver: VendureYogaDriver,
        useFactory: (
            configService: ConfigService,
            i18nService: I18nService,
            idCodecService: IdCodecService,
            typesLoader: GraphQLTypesLoader,
            customFieldRelationResolverService: CustomFieldRelationResolverService,
        ) => {
            return createGraphQLOptions(
                i18nService,
                configService,
                idCodecService,
                typesLoader,
                customFieldRelationResolverService,
                getOptions(configService),
            );
        },
        inject: [
            ConfigService,
            I18nService,
            IdCodecService,
            GraphQLTypesLoader,
            CustomFieldRelationResolverService,
        ],
        imports: [ConfigModule, I18nModule, ApiSharedModule, ServiceModule],
    });
}

async function createGraphQLOptions(
    i18nService: I18nService,
    configService: ConfigService,
    idCodecService: IdCodecService,
    typesLoader: GraphQLTypesLoader,
    customFieldRelationResolverService: CustomFieldRelationResolverService,
    options: GraphQLApiOptions,
): Promise<YogaDriverConfig> {
    const builtSchema = await buildSchemaForApi(options.apiType);
    const resolvers = await generateResolvers(
        configService,
        customFieldRelationResolverService,
        options.apiType,
        builtSchema,
    );
    const { apiOptions } = configService;

    const plugins: YogaPlugin[] = [
        // Reproduces the error codes / HTTP statuses that Apollo Server produced, so that the
        // response shape seen by API clients is unchanged.
        useApolloCompatibleErrors(),
        useValidationRules({
            rules: options.validationRules as ValidationRule[],
            introspection: apiOptions.introspection ?? true,
        }),
        // Apollo Server enabled Automatic Persisted Queries by default, and storefronts built
        // on Apollo Client's `createPersistedQueryLink()` rely on the protocol being present.
        useAPQ(),
        new TranslateErrorsPlugin(i18nService),
        new AssetInterceptorPlugin(configService),
    ];
    if (apiOptions.csrfPrevention) {
        // Runs first so that a blocked request never reaches the request parser.
        plugins.unshift(useCsrfPrevention(apiOptions.csrfPrevention));
    }
    // We only need to add the IdCodecPlugin if the user has configured
    // a non-default EntityIdStrategy. This is a performance optimization
    // that prevents unnecessary traversal of each response when no
    // actual encoding/decoding is taking place.
    if (
        !isUsingDefaultEntityIdStrategy(
            configService.entityOptions.entityIdStrategy ?? configService.entityIdStrategy,
        )
    ) {
        plugins.push(new IdCodecPlugin(idCodecService, options.apiType));
    }
    plugins.push(...(apiOptions.graphqlPlugins ?? []));
    if (apiOptions.apolloServerPlugins.length) {
        // Any Apollo Server plugins supplied by the user (or by Vendure plugins such as
        // HardenPlugin) keep working through the compatibility layer. They run after Vendure's
        // own plugins, exactly as they did when all of them were Apollo Server plugins.
        plugins.push(
            useApolloServerPlugins({
                plugins: apiOptions.apolloServerPlugins,
                getRequestHeaders: getOriginalRequestHeaderEntries,
            }),
        );
    }

    return {
        path: '/' + options.apiPath,
        typeDefs: printSchema(builtSchema),
        include: [options.resolverModule],
        inheritResolversFromInterfaces: true,
        fieldResolverEnhancers: ['guards'],
        resolvers,
        // File uploads are handled by the graphql-upload Express middleware (see ApiModule), which
        // has already parsed any multipart body by the time the request reaches Yoga. Yoga's own
        // multipart parsing is therefore switched off. See https://github.com/vendurehq/vendure/issues/396
        multipart: false,
        // `playground` is a deprecated alias for GraphiQL. The options it used to accept configured
        // the GraphQL Playground, which no longer exists, so only the truthiness of the configured
        // value still means anything: a truthy value serves GraphiQL at the API path.
        graphiql: options.playground ? { title: `Vendure ${options.apiType === 'admin' ? 'Admin' : 'Shop'} API` } : false,
        // Only the API path itself is served; Yoga's landing page for unhandled routes is not wanted
        // behind Nest's router.
        landingPage: false,
        // Apollo Server exposed error messages unchanged (only stack traces were suppressed), and
        // Vendure's own I18nError messages are meant to reach the client, so masking stays off.
        // Yoga never includes stack traces in responses, which is what Vendure already enforced.
        maskedErrors: false,
        // Apollo Server rejected batched requests by default; Yoga does the same when unset.
        batching: false,
        // This is handled by the Express cors plugin
        cors: false,
        logging: createYogaLogger(),
        plugins,
    } as YogaDriverConfig;

    /**
     * Generates the server's GraphQL schema by combining:
     * 1. the default schema as defined in the source .graphql files specified by `typePaths`
     * 2. any custom fields defined in the config
     * 3. any schema extensions defined by plugins
     */
    async function buildSchemaForApi(apiType: 'shop' | 'admin'): Promise<GraphQLSchema> {
        return getFinalVendureSchema({
            config: configService,
            typePaths: options.typePaths,
            typesLoader,
            apiType,
        });
    }
}
