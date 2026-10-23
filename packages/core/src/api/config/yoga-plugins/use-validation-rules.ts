import { NoSchemaIntrospectionCustomRule, ValidationRule } from 'graphql';
import { Plugin } from 'graphql-yoga';

/**
 * Registers additional graphql-js validation rules for every operation. This is how
 * `apiOptions.shopApiValidationRules` / `apiOptions.adminApiValidationRules` and
 * `apiOptions.introspection: false` reach the server.
 *
 * Disabling introspection uses graphql-js' own `NoSchemaIntrospectionCustomRule`, which is
 * also what Apollo Server used for `introspection: false`, so the resulting error message is
 * identical.
 */
export function useValidationRules(options: {
    rules: readonly ValidationRule[];
    introspection: boolean;
}): Plugin {
    const rules: ValidationRule[] = [...options.rules];
    if (!options.introspection) {
        rules.push(NoSchemaIntrospectionCustomRule);
    }
    if (rules.length === 0) {
        return {};
    }
    return {
        onValidate({ addValidationRule }) {
            for (const rule of rules) {
                addValidationRule(rule);
            }
        },
    };
}
