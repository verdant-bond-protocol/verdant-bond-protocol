import EmbeddedPostgres from 'embedded-postgres';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const port = Number(process.argv[2] || 57432);
const databaseDir = path.join(os.tmpdir(), `oracle-incident-repo-test-${crypto.randomUUID()}`);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'test',
  password: 'test',
  port,
  persistent: false,
});

await pg.initialise();
await pg.start();
await pg.createDatabase('testdb');

console.log(`PGREADY:postgresql://test:test@localhost:${port}/testdb`);

async function shutdown() {
  try {
    await pg.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
