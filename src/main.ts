#!/usr/bin/env node
import { runCli } from "./cli.js";

runCli(process.argv).catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
