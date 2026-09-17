import { QUEUES, createBoss } from '@mps/queue';

async function main() {
  const jobs = process.argv.slice(2);
  const boss = createBoss(process.env.DATABASE_URL!, 'client');
  await boss.start();
  for (const j of jobs) {
    const idx = j.indexOf(':');
    const name = idx === -1 ? j : j.slice(0, idx);
    const dataStr = idx === -1 ? '' : j.slice(idx + 1);
    const data = dataStr ? JSON.parse(dataStr) : {};
    const id = await boss.send(name as (typeof QUEUES)[keyof typeof QUEUES], data);
    console.log(`sent ${name} -> ${id}`);
  }
  await boss.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
