#!/usr/bin/env node
import { runCli } from '../src/cli.js';

// `hunkproof ... | head` closes stdout early: leave quietly instead of dumping a stack.
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(process.exitCode || 0); throw e; });

process.exitCode = await runCli(process.argv.slice(2));
