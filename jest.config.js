module.exports = {
  transform: {
    '^.+\\.tsx?$': require.resolve('ts-jest')
  },
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
};