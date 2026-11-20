import { runRepairCli } from '../src/recovery/repair-cli';

let stopRequested = false;
process.on('SIGINT', () => {
  stopRequested = true;
  process.stderr.write('\nStop requested after the current step; resume with `repair resume --run <id>`.\n');
});

runRepairCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  shouldStop: () => stopRequested,
}).then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
