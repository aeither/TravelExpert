import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const repo = resolve(import.meta.dirname, '..');
export const privateDir = resolve(repo, '.local');
export const serviceDir = resolve(process.env.MPS_DIR || resolve(repo, '../masumi-payment-service'));
export const configFile = resolve(privateDir, 'mps.env');

export function readEnv(path) {
  return Object.fromEntries(readFileSync(path, 'utf8').split('\n').flatMap(line => {
    const match = line.match(/^([A-Z_0-9]+)=(.*)$/);
    return match ? [[match[1], match[2].replace(/^(["'])(.*)\1$/, '$2')]] : [];
  }));
}

export function paymentEnv() {
  return { ...process.env, ...readEnv(configFile) };
}
