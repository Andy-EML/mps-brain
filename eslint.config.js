import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/drizzle/**', 'fixtures/**'] },
  ...tseslint.configs.recommended,
);
