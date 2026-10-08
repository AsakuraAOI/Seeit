#!/usr/bin/env node

import { runCli } from "./app.js";

const exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
});
process.exitCode = exitCode;
