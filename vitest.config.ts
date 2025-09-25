import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Suppress unhandled errors that are expected in tests
    // These are errors that tests intentionally trigger and expect to catch
    // @ts-expect-error - vitest handles this correctly
    onUnhandledRejection: (error: {
      name: string;
      message: string | string[];
    }) => {
      // Ignore Prelude* errors as they are expected test scenarios
      return (
        !(error instanceof Error) ||
        (!error.name.startsWith('Prelude') &&
          !error.message.includes('Missing or invalid prelude'))
      );
      // Treat other errors as unhandled
    },

    // Other test configuration
    globals: true,
    environment: 'node',
    testTimeout: 10000,
  },
});
