const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, tier: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: 'asc' }
  });
  console.log('Total users:', users.length);
  console.log('Note: admin status is determined at login by ADMIN_EMAILS env var, not DB tier.');
  console.log('');
  for (const u of users) {
    console.log(`  tier=${u.tier.padEnd(8)} ${u.email.padEnd(45)} created=${u.createdAt.toISOString().slice(0,10)} updated=${u.updatedAt.toISOString().slice(0,10)}`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
