import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
mkdirSync(".sites-runtime/tests", { recursive: true });
const names = readdirSync("tests").filter(name => name.endsWith(".test.ts"));
await build({
  entryPoints: names.map(name=>"tests/"+name),
  outdir: ".sites-runtime/tests",
  outExtension: {".js":".cjs"},
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node26",
});
const result = spawnSync(
  process.execPath,
  ["--test", ...names.map(name=>".sites-runtime/tests/"+name.replace(/\.ts$/,".cjs"))],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      AWESOME_ADB_DATA_DIR: process.cwd() + "/.sites-runtime/test-data",
    },
  },
);
process.exitCode = result.status || 0;
