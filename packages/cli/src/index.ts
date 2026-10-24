#!/usr/bin/env node
import { run } from "./cli.js";
import { terminalConfirm } from "./confirm.js";

const result = await run(process.argv.slice(2), {
  confirm: terminalConfirm(),
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
