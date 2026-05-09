const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const email = process.argv[2];
const newPassword = process.argv[3];
const rounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

if (!email || !newPassword) {
  console.error('Usage: node scripts/reset-password.js <email> <newPassword>');
  process.exit(1);
}

const prisma = new PrismaClient();
async function main() {
  const hash = await bcrypt.hash(newPassword, rounds);
  const updated = await prisma.user.update({
    where: { email },
    data: { passwordHash: hash },
    select: { id: true, email: true, tier: true, updatedAt: true }
  });
  console.log('Password reset OK:');
  console.log(`  email     = ${updated.email}`);
  console.log(`  tier      = ${updated.tier}`);
  console.log(`  updatedAt = ${updated.updatedAt.toISOString()}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
