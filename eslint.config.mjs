import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(eslint.configs.recommended, ...tseslint.configs.recommended, {
	ignores: ['dist/**', 'out/**', 'node_modules/**', 'esbuild.js', 'jest.config.js', 'eslint.config.mjs', 'src/test/setup.js'],
	rules: {
		'@typescript-eslint/no-unused-vars': 'warn',
		'@typescript-eslint/no-explicit-any': 'warn',
	},
});
