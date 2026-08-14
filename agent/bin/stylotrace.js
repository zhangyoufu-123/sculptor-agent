#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

const entry = new URL('../src/cli.js', import.meta.url);
process.argv[1] = fileURLToPath(entry);
await import(entry);
