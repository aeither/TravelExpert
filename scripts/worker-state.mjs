import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Invalid Task or Coworker ID.');
  }
  return value;
}

export async function atomicWrite(path, text) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function createStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = id => join(directory, `${safeId(id)}.json`);
  return {
    async ids() {
      return (await readdir(directory)).filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name)).map(name => name.slice(0, -5));
    },
    async read(id) {
      try { return JSON.parse(await readFile(path(id), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async save(state) {
      await atomicWrite(path(state.taskId), `${JSON.stringify(state, null, 2)}\n`);
    },
    async result(id, text) {
      const resultPath = join(directory, `${safeId(id)}.result.txt`);
      await atomicWrite(resultPath, text);
      return resultPath;
    },
    async lock(coworkerId) {
      const lockPath = join(directory, `${safeId(coworkerId)}.lock`);
      try { await mkdir(lockPath, { mode: 0o700 }); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('Worker lock exists. Inspect the executor before removing the lock.');
        throw error;
      }
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
      return () => rm(lockPath, { recursive: true });
    },
  };
}
