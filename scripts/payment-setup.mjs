import { mkdirSync, existsSync, writeFileSync, openSync, closeSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { configFile, privateDir, repo, serviceDir, readEnv, paymentEnv } from './payment-config.mjs';

const database = 'token2049_event_guide';
const role = 'token2049_event_guide';
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
chmodSync(privateDir, 0o700);
if (!existsSync(resolve(serviceDir, 'node_modules/.bin/prisma'))) {
  throw new Error('MPS_DIR must point to a payment service checkout with locked dependencies installed.');
}
if (!existsSync(configFile)) {
  const key = readEnv(resolve(repo, '.env')).BLOCKFROST_API_KEY_PREPROD;
  if (!/^preprod[A-Za-z0-9]{20,}$/.test(key || '')) throw new Error('A valid Preprod Blockfrost project key is required.');
  const password = randomBytes(24).toString('hex');
  const env = {
    DATABASE_URL: `postgresql://${role}:${password}@127.0.0.1:5432/${database}?schema=public`,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_KEY: randomBytes(32).toString('hex'),
    BLOCKFROST_API_KEY_PREPROD: key,
    BLOCKFROST_API_KEY_MAINNET: '',
    BLOCKFROST_API_KEY_PREVIEW: '',
    PORT: '3012',
    SEED_ONLY_IF_EMPTY: 'true',
    SEED_V1_LEGACY: '',
    AUTO_WITHDRAW_PAYMENTS: 'true',
    OTEL_ENABLED: 'false',
  };
  for (const network of ['PREPROD', 'MAINNET']) {
    for (const prefix of ['PURCHASE_WALLET', 'SELLING_WALLET', 'PURCHASE_WALLET_V2', 'SELLING_WALLET_V2']) {
      env[`${prefix}_${network}_MNEMONIC`] = '';
    }
    env[`COLLECTION_WALLET_${network}_ADDRESS`] = '';
    env[`COLLECTION_WALLET_V2_${network}_ADDRESS`] = '';
  }
  const check = spawnSync('psql', ['-d', 'postgres', '-Atc', `SELECT count(*) FROM pg_database WHERE datname='${database}'`], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error('Cannot access local PostgreSQL.');
  if (check.stdout.trim() !== '0') throw new Error('Demo database already exists without its encryption configuration. Do not overwrite it.');
  // Save the encryption key before creating the database. Keep this file with database backups.
  writeFileSync(configFile, Object.entries(env).map(([name, value]) => `${name}=${value}\n`).join(''), { mode: 0o600, flag: 'wx' });
  const sql = `CREATE ROLE ${role} LOGIN PASSWORD '${password}';\nCREATE DATABASE ${database} OWNER ${role};\n`;
  const created = spawnSync('psql', ['-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
  if (created.status !== 0) throw new Error('Database creation failed. Inspect role and database state before retrying. Private configuration is preserved.');
  console.log(`Created dedicated PostgreSQL database: ${database}`);
}

function run(args, logName) {
  const log = resolve(privateDir, logName);
  const fd = openSync(log, 'a', 0o600);
  try {
    const result = spawnSync(process.execPath, args, {
      cwd: serviceDir, env: paymentEnv(), stdio: ['ignore', fd, fd], timeout: 180_000,
    });
    if (result.status !== 0) throw new Error(`${logName} failed. Exit ${result.status}. Inspect the private log locally; do not copy wallet seeds into chat.`);
    console.log(`${logName}: exit 0`);
  } finally { closeSync(fd); }
}
run(['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', 'prisma/prisma.config.ts'], 'migrations.log');
// Seeding can print mnemonic phrases. Send all output directly to a permission-600 local backup.
run(['node_modules/tsx/dist/cli.mjs', 'prisma/seed.ts'], 'wallet-seed.private.log');
console.log('Payment node configured on port 3012. Wallet seed output stayed in private local storage.');
