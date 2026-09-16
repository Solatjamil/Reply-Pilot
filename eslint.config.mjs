import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  // Prisma's generated client is vendored into src/generated — never lint it.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Ours:
    "src/generated/**",
    "prisma/**",
    "scripts/**",
    "worker.ts",
  ]),
  ...nextVitals,
  ...nextTs,
]);

export default eslintConfig;
