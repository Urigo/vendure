import { YogaDriverConfig } from '@graphql-yoga/nestjs';
import { useAPQ } from '@graphql-yoga/plugin-apq';
import { DynamicModule } from '@nestjs/common';
import { GraphQLModule, GraphQLTypesLoader } from '@nestjs/graphql';
import { GraphQLSchema, printSchema, ValidationContext, ValidationRule } from 'graphql';
import { Plugin as YogaPlugin } from 'graphql-yoga';

import { ConfigModule } from '../../config/config.module';
import { ConfigService } from '../../config/config.service';
import { Logger } from '../../config/logger/vendure-logger';
import { I18nModule } from '../../i18n/i18n.module';
import { I18nService } from '../../i18n/i18n.service';
import { ServiceModule } from '../../service/service.module';
import { ApiSharedModule } from '../api-internal-modules';
import { CustomFieldRelationResolverService } from '../common/custom-field-relation-resolver.service';
import { IdCodecService } from '../common/id-codec.service';
import { AssetInterceptorPlugin } from '../middleware/asset-interceptor-plugin';
import { IdCodecPlugin } from '../middleware/id-codec-plugin';
import { TranslateErrorsPlugin } from '../middleware/translate-errors-plugin';

import { ApolloLogger, createVendureApolloServerPluginsCompat } from './apollo-server-plugin-compat';
import { generateResolvers } from './generate-resolvers';
import { getFinalVendureSchema, isUsingDefaultEntityIdStrategy } from './get-final-vendure-schema';
import { VendureYogaDriver } from './vendure-yoga-driver';
import { createYogaLogger } from './yoga-plugins/create-yoga-logger';
import { getOriginalRequestHeaderEntries } from './yoga-plugins/original-request-headers';
import { useApolloCompatibleErrors } from './yoga-plugins/use-apollo-compatible-errors';
import { useCsrfPrevention } from './yoga-plugins/use-csrf-prevention';
import { useIgnoreUnknownParams } from './yoga-plugins/use-ignore-unknown-params';
import { useValidationRules } from './yoga-plugins/use-validation-rules';

const apolloLoggerCtx = 'ApolloServerPlugin';
const apolloLogger: ApolloLogger = {
    debug: (message?: unknown) => Logger.debug(String(message), apolloLoggerCtx),
    info: (message?: unknown) => Logger.info(String(message), apolloLoggerCtx),
    warn: (message?: unknown) => Logger.warn(String(message), apolloLoggerCtx),
    error: (message?: unknown) => Logger.error(String(message), apolloLoggerCtx),
};

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

    // Apollo Server plugins supplied by the user (or by Vendure plugins such as HardenPlugin) keep
    // working through the compatibility layer, together with the plugins which Apollo Server and
    // @nestjs/apollo installed implicitly (cache control, APOLLO_KEY usage reporting, and Nest's
    // "200 once data has been produced" status handling), in the order Apollo Server ran them.
    const apolloCompat = createVendureApolloServerPluginsCompat(apiOptions.apolloServerPlugins, {
        logger: apolloLogger,
        getRequestHeaders: getOriginalRequestHeaderEntries,
    });

    // BENCHMARK-ONLY switch (not part of the PR): full | nocompat | bare
    const benchMode = process.env.VENDURE_YOGA_MODE ?? 'full';
    const withCompat = benchMode === 'full';
    const withApolloCompatibleRequestHandling = benchMode !== 'bare';
    const plugins: YogaPlugin[] = [];
    if (withCompat) {
        plugins.push(apolloCompat.early);
    }
    if (withApolloCompatibleRequestHandling) {
        plugins.push(useApolloCompatibleErrors(), useIgnoreUnknownParams());
    }
    plugins.push(
        useValidationRules({
            rules: options.validationRules as ValidationRule[],
            introspection: apiOptions.introspection ?? true,
        }),
    );
    if (withApolloCompatibleRequestHandling) {
        plugins.push(useAPQ());
    }
    if (apiOptions.csrfPrevention) {
        plugins.unshift(useCsrfPrevention(apiOptions.csrfPrevention));
    }
    if (
        !isUsingDefaultEntityIdStrategy(
            configService.entityOptions.entityIdStrategy ?? configService.entityIdStrategy,
        )
    ) {
        plugins.push(new IdCodecPlugin(idCodecService, options.apiType));
    }
    plugins.push(new TranslateErrorsPlugin(i18nService), new AssetInterceptorPlugin(configService));
    if (withCompat) {
        plugins.push(apolloCompat.mid);
    }
    plugins.push(...(apiOptions.graphqlPlugins ?? []));
    if (withCompat) {
        plugins.push(apolloCompat.late);
    }
    // eslint-disable-next-line no-console
    console.log(`[bench] Yoga mode: ${benchMode}, plugins: ${plugins.length}`);

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
        graphiql: options.playground
            ? { title: `Vendure ${options.apiType === 'admin' ? 'Admin' : 'Shop'} API` }
            : false,
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
