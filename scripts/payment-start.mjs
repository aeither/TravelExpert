import { spawn } from 'node:child_process';
import { serviceDir, paymentEnv } from './payment-config.mjs';

const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {
  cwd: serviceDir, env: paymentEnv(), stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Cannot start the local payment service.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
