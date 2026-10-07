// Runs board.mjs for board-runner.mjs inside this worker thread instead of a new Node process per call, and hands its
// `gh` calls to the fake gh (fake-gh.mjs) instead of starting a process per call. A case of the board tests makes about
// eight such starts; at 70 to 150 ms each (Windows, virus scanner) they were most of the suite's run time.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { format } from 'node:util';
import { workerData } from 'node:worker_threads';
import { fakeGh } from './fake-gh.mjs';

const { requests, results, done } = workerData;
const boardUrl = new URL('../board.mjs', import.meta.url).href;

// board.mjs imports execFileSync from node:child_process: only calls of `gh` are faked, other programs (the Sonar request) run for real.
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => /(^|[\\/])gh(\.exe)?$/.test(file) ? fakeGh(args, options?.input) : realExecFileSync(file, args, options);
syncBuiltinESMExports();
// ponytail: board.mjs waits between reads with Atomics.wait; no test depends on elapsed time, so waits end at once; replace when one does.
Atomics.wait = () => 'timed-out';

class ProcessExit extends Error {}

let count = 0;
requests.onmessage = async ({ data: { args, env } }) => {
  let status = 0;
  const say = stream => (...parts) => results.postMessage({ stream, text: `${format(...parts)}\n` });
  const [log, error, warn, exit] = [console.log, console.error, console.warn, process.exit];
  [console.log, console.error, console.warn] = [say('stdout'), say('stderr'), say('stderr')];
  process.exit = code => { throw Object.assign(new ProcessExit(), { code: code ?? process.exitCode ?? 0 }); };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  process.argv = [process.execPath, 'board.mjs', ...args];
  process.exitCode = undefined;
  try {
    await import(`${boardUrl}?call=${++count}`);
    status = process.exitCode ?? 0;
  } catch (thrown) {
    // Like Node: process.exit() ends with its code, any other uncaught error prints its stack and ends with 1.
    if (thrown instanceof ProcessExit) status = thrown.code;
    else { results.postMessage({ stream: 'stderr', text: `${thrown?.stack ?? thrown}\n` }); status = 1; }
  } finally {
    [console.log, console.error, console.warn, process.exit] = [log, error, warn, exit];
  }
  results.postMessage({ status });
  Atomics.store(done, 0, 1);
  Atomics.notify(done, 0);
};
