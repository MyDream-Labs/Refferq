import { createMockPrisma, InMemoryPrisma } from '../utils/test-prisma-fixture';

export const prisma: InMemoryPrisma = createMockPrisma();
export const db = {
  ...prisma,
  getAffiliateByReferralCode: prisma.db.getAffiliateByReferralCode,
  getAffiliateByUserId: prisma.db.getAffiliateByUserId,
};
