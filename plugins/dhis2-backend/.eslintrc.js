module.exports = require('@backstage/cli/config/eslint-factory')(__dirname, {
  rules: {
    'no-console': 'warn',
    'no-nested-ternary': 'warn',
    radix: 'warn',
    'no-loop-func': 'warn',
    'no-alert': 'warn',
    'default-case': 'warn',
    'consistent-return': 'warn',
  },
  tsRules: {
    '@typescript-eslint/no-use-before-define': 'warn',
    '@typescript-eslint/no-useless-constructor': 'warn',
    '@typescript-eslint/no-shadow': 'warn',
    '@backstage/no-relative-monorepo-imports': 'warn',
    '@backstage/no-undeclared-imports': 'warn',
  },
});
