import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, symlink, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// One Railway service, three processes: the eve agent (loopback only), the public MIP-003 API, and the Sokosumi paid worker.
// Single replica on a volume. A lock left by a killed process is stale, so clear locks (never journals) before starting.
const root = resolve(import.meta.dirname, '..');
const data = resolve(process.env.DATA_DIR || '/data');
// The eve server is loopback only. Its shared password is generated per boot unless one is configured, and never leaves this process tree.
const env = { ...process.env, DATA_DIR: data, EVE_URL: 'http://127.0.0.1:2000', HOST: '0.0.0.0', EVE_INTERNAL_PASSWORD: process.env.EVE_INTERNAL_PASSWORD || randomBytes(24).toString('hex') };

await mkdir(resolve(data, 'worker'), { recursive: true });
await rm(resolve(data, 'agent-api/owner.lock'), { force: true });
await mkdir(resolve(data, 'travel'), { recursive: true });
for (const dir of ['worker', 'travel']) for (const name of await readdir(resolve(data, dir))) if (name.endsWith('.lock')) await rm(resolve(data, dir, name), { recursive: true, force: true });
// eve keeps run state under .eve/.workflow-data; point it at the volume so sessions survive a redeploy.
await mkdir(resolve(data, 'workflow'), { recursive: true });
await mkdir(resolve(root, '.eve'), { recursive: true });
const link = resolve(root, '.eve/.workflow-data');
if (await lstat(link).then(() => true, () => false)) await rm(link, { recursive: true, force: true });
await symlink(resolve(data, 'workflow'), link);

const children = new Map();
let stopping = false;
function run(name, args, { optional = false } = {}) {
  const loop = async () => {
    while (!stopping) {
      const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
      children.set(name, child);
      const code = await new Promise(done => child.once('exit', done));
      if (stopping) return;
      console.error(`[${name}] exited with ${code}; restarting in 15 s`);
      await delay(15_000);
    }
  };
  void loop();
  return optional;
}
async function healthy() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${env.EVE_URL}/eve/v1/health`)).ok) return true; } catch {}
    await delay(2_000);
  }
  return false;
}

run('eve', ['node_modules/eve/bin/eve.js', 'start', '--host', '127.0.0.1', '--port', '2000']);
if (!await healthy()) console.error('[eve] did not become healthy in 120 s; the API reports unavailable until it does');
run('api', ['scripts/agent-api.mjs']);
// The paid worker needs the registration. Until MASUMI_AGENT_IDENTIFIER is set the service only answers /availability as unavailable.
if (env.MASUMI_AGENT_IDENTIFIER && env.SOKOSUMI_COWORKER_API_KEY) run('worker', ['scripts/travel-worker.mjs']);
else console.error('[worker] not started: MASUMI_AGENT_IDENTIFIER or SOKOSUMI_COWORKER_API_KEY is missing');

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; for (const child of children.values()) child.kill(signal); setTimeout(() => process.exit(0), 5_000).unref(); });
