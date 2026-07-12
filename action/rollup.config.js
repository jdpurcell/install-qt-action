import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const config = {
  input: "src/main.ts",
  output: {
    file: "dist/index.js",
    format: "es",
    inlineDynamicImports: true,
    // Provide `require` for CommonJS dependencies bundled into this ESM output.
    // minimatch v3 falls back to POSIX separators when `require("path")` fails,
    // which prevents @actions/glob from matching paths on Windows runners.
    // https://github.com/actions/toolkit/issues/2085
    banner: `import { createRequire as __bundleRequire } from "module";`,
    intro: `const require = __bundleRequire(import.meta.url);`,
  },
  plugins: [typescript(), nodeResolve({ preferBuiltins: true }), json(), commonjs()],
};

export default config;
