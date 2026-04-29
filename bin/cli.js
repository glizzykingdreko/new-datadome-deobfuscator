#!/usr/bin/env node
/**
 * CLI shim for the DataDome deobfuscator.
 *
 * Usage:
 *   datadome-deobfuscate <input> [outputPrefix] [flags]
 *
 * Args:
 *   <input>         Path to the obfuscated source file.
 *   [outputPrefix]  Prefix for generated output files. If it ends with '/' you
 *                   get a directory of files named '<prefix><module>.js'.
 *
 * Flags:
 *   --input <path>          Alternative to the positional input argument.
 *   --output <path>         Alternative to the positional outputPrefix argument.
 *   --report <path>         Write the structured report to this JSON file.
 *   --log-level <LEVEL>     DEBUG | INFO | WARN | ERROR | NONE   (default INFO).
 *   --no-delimiter          Suppress the RESULT_DELIMITER stdout line.
 *   -h, --help              Show this help and exit.
 */

const fs = require('fs');
const path = require('path');
const { deobfuscate, Logger, LogLevel } = require('../lib');

const RESULT_DELIMITER = '===DEOBFUSCATOR_RESULT===';

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.flags.help = true;
    else if (a === '--no-delimiter') out.flags.noDelimiter = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out.flags[key] = next; i++; }
      else out.flags[key] = true;
    } else out.positional.push(a);
  }
  return out;
}

function printUsage() {
  console.log(`Usage: datadome-deobfuscate <input> [outputPrefix] [flags]

Args:
  <input>         Path to the obfuscated source file.
  [outputPrefix]  Prefix for generated files (default ./output_full.js).

Flags:
  --input <path>       Alternative to the positional input argument.
  --output <path>      Alternative to the positional outputPrefix argument.
  --report <path>      Write the structured report to this JSON file.
  --log-level <LEVEL>  DEBUG | INFO | WARN | ERROR | NONE (default INFO).
  --no-delimiter       Suppress the RESULT_DELIMITER stdout line.
  -h, --help           Show this help.

Exit codes:
  0  clean run, 1 fatal error, 2 completed with errors/warnings.`);
}

function resolveLogLevel(name) {
  if (name === undefined || name === true) return 'INFO';
  const upper = String(name).toUpperCase();
  if (LogLevel[upper] === undefined) {
    console.error(`Unknown --log-level "${name}". Valid: DEBUG, INFO, WARN, ERROR, NONE.`);
    process.exit(1);
  }
  return upper;
}

const args = parseArgs(process.argv);
if (args.flags.help) { printUsage(); process.exit(0); }

const inputFile = args.flags.input || args.positional[0];
const outputPrefix = args.flags.output || args.positional[1] || './output_full.js';
const reportPath = args.flags.report === true ? null : (args.flags.report || null);
const delimiterEnabled = !args.flags.noDelimiter;
const logLevel = resolveLogLevel(args.flags['log-level']);

if (!inputFile) { printUsage(); process.exit(1); }

const logger = new Logger(LogLevel[logLevel] || LogLevel.INFO, 'CLI');

let source;
try {
  source = fs.readFileSync(inputFile, 'utf8');
} catch (err) {
  console.error(`Failed to read input ${inputFile}: ${err.message}`);
  process.exit(1);
}

const result = deobfuscate(source, { logLevel, logger });

const writtenFiles = [];
for (const [name, code] of Object.entries(result.modules)) {
  const filePath = `${outputPrefix}${name}.js`;
  try {
    fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    fs.writeFileSync(filePath, code);
    writtenFiles.push(`${name}.js`);
    logger.info('Output file written', { path: filePath, size: code.length });
  } catch (err) {
    logger.error(`Failed to write ${filePath}`, { error: err.message });
  }
}

const summary = {
  ...result.report,
  input: inputFile,
  outputPrefix,
  outputDir: path.dirname(path.resolve(outputPrefix)),
  files: writtenFiles,
  counts: { ...result.report.counts, filesWritten: writtenFiles.length },
};

if (reportPath) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));
    logger.info('Report written', { path: reportPath });
  } catch (err) {
    logger.error('Failed to write report', { path: reportPath, error: err.message });
  }
}

if (delimiterEnabled) {
  console.log(RESULT_DELIMITER);
  console.log(JSON.stringify(summary));
}

if (summary.counts.errors > 0) process.exitCode = 2;
