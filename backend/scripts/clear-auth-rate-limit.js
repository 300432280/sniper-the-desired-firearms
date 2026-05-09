const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);
async function main() {
  const keys = await redis.keys('rl:auth:*');
  console.log(`Found ${keys.length} auth-rate-limit keys`);
  if (keys.length > 0) {
    const deleted = await redis.del(...keys);
    console.log(`Deleted ${deleted} keys`);
    for (const k of keys) console.log(`  ${k}`);
  }
  await redis.quit();
}
main().catch(e => { console.error(e); process.exit(1); });
