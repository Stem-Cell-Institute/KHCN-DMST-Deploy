// ESLint flat config for document-workflow-ui
// Enforces DDD-like boundaries: new code must import from `@/features/*` or `@/shared/*`,
// the legacy paths (`@/components/admin/AdminPrimitives`, `@/lib/api`, `@/components/ui`) are
// deprecated and gated by `no-restricted-imports`.
//
// Run: `npm run lint` (script added in package.json).
// The rule also forbids raw axios usage outside `@/shared/lib/http`.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

const deprecatedImportPatterns = [
  {
    group: ["@/components/admin/AdminPrimitives"],
    message:
      "Deprecated path. Import primitives from '@/shared/ui/primitives' and admin cards from '@/features/document-workflow/admin/components/AdminCards'.",
  },
  {
    group: ["@/components/ui"],
    message: "Deprecated path. Import UI primitives from '@/shared/ui/primitives'.",
  },
  {
    group: ["@/components/admin/AdminGuard"],
    message:
      "Deprecated path. Import AdminGuard from '@/features/document-workflow/admin/components/AdminGuard'.",
  },
  {
    group: ["@/lib/api", "@/lib/api/*"],
    message:
      "Deprecated path. Import API use-cases from '@/features/document-workflow/use-cases/*' or '@/features/document-workflow/admin/use-cases/*'. Use '@/shared/lib/http' only when you truly need the axios client.",
  },
];

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "**/*.d.ts", "tsconfig*.tsbuildinfo"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-imports": [
        "error",
        {
          patterns: deprecatedImportPatterns,
          paths: [
            {
              name: "axios",
              message:
                "Do not import axios directly. Use the shared client from '@/shared/lib/http' so auth + baseURL stay consistent.",
            },
          ],
        },
      ],
    },
  },
  // Re-export shims + legacy pages are INTENTIONAL and need to keep the deprecated imports
  // until content migration sprint. New code (features/, shared/, App.tsx, main.tsx) is gated.
  {
    files: [
      "src/components/**/*.{ts,tsx}",
      "src/pages/**/*.{ts,tsx}",
      "src/lib/api.ts",
      "src/shared/lib/http.ts",
      "src/features/document-workflow/pages/**",
      "src/features/document-workflow/admin/pages/**",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    rules: {
      "no-restricted-imports": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  }
);
