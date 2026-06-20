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
  },
  plugins: [typescript(), nodeResolve({ preferBuiltins: true }), json(), commonjs()],
};

export default config;
