import { GraphQLError } from 'graphql';
import { handleStreamOrSingleExecutionResult, Plugin } from 'graphql-yoga';

import { I18nService } from '../../i18n/i18n.service';

type OnExecuteHookResult = Awaited<ReturnType<NonNullable<Plugin['onExecute']>>>;

/**
 * This plugin intercepts outgoing responses and translates any error messages into the
 * current request language.
 */
export class TranslateErrorsPlugin implements Plugin {
    constructor(private i18nService: I18nService) {}

    onExecute = (): OnExecuteHookResult => {
        return {
            onExecuteDone: payload =>
                handleStreamOrSingleExecutionResult(payload, ({ result, setResult, args }) => {
                    if (!result.errors?.length) {
                        return;
                    }
                    const req = (args.contextValue as any)?.req;
                    setResult({
                        ...result,
                        errors: result.errors.map(err =>
                            this.i18nService.translateError(req, err as GraphQLError),
                        ),
                    });
                }),
        };
    };
}
