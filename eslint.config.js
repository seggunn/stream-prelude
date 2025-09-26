import { sxzz } from '@sxzz/eslint-config';

export default sxzz(
  {
    prettier: true,
    markdown: true,
    // TypeScript will be auto-detected
  },
  [
    // Custom rules can be added here if needed
    {
      ignores: ['README.md'],
    },
  ]
);
