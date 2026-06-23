import { vi } from 'vitest';

type MockQueryModel = {
  findUnique: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
  aggregate: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};

export type InMemoryPrisma = {
  $transaction: ReturnType<typeof vi.fn>;
  db: {
    getAffiliateByReferralCode: ReturnType<typeof vi.fn>;
    getAffiliateByUserId: ReturnType<typeof vi.fn>;
    getPlatformSettings: ReturnType<typeof vi.fn>;
    getProgramSettings: ReturnType<typeof vi.fn>;
  };
  user: MockQueryModel;
  affiliate: MockQueryModel & {
    createMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  oTP: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  rateLimitEntry: {
    deleteMany: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  referral: MockQueryModel;
  integrationSettings: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  apiKey: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  payout: MockQueryModel & {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  commission: MockQueryModel & {
    findFirst: ReturnType<typeof vi.fn>;
  };
  conversion: MockQueryModel & {
    findFirst: ReturnType<typeof vi.fn>;
  };
  commissionRule: MockQueryModel;
  referralClick: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  resource: {
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  auditLog: {
    create: ReturnType<typeof vi.fn>;
  };
  partnerGroup: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  transaction: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  programSettings: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  rateLimit: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  apiUsageLog: {
    create: ReturnType<typeof vi.fn>;
  };
  emailTemplate: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  emailLog: {
    findFirst: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
};

function makeQueryModel(overrides: Partial<MockQueryModel> = {}): MockQueryModel {
  return {
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    create: vi.fn(async (params: { data?: unknown }) => ({ id: 'mock-id', ...(params?.data ?? {}) })),
    update: vi.fn(async (params: { data?: unknown; where?: unknown }) => ({
      id: 'mock-id',
      ...((params as { where?: unknown }).where || {}),
      ...(params?.data || {}),
    })),
    delete: vi.fn(async (params: { where?: unknown }) => ({
      id: 'mock-id',
      ...((params as { where?: unknown }).where || {}),
    })),
    updateMany: vi.fn(async () => ({ count: 0 })),
    createMany: vi.fn(async () => ({ count: 0 })),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    aggregate: vi.fn(async () => ({ _sum: { requestCount: 0 } })),
    groupBy: vi.fn(async () => []),
    upsert: vi.fn(async () => ({ id: 'mock-id' })),
    count: vi.fn(async () => 0),
    ...overrides,
  };
}

function makeDbHelpers() {
  return {
    getAffiliateByReferralCode: vi.fn(async () => null),
    getAffiliateByUserId: vi.fn(async () => null),
    getPlatformSettings: vi.fn(async () => null),
    getProgramSettings: vi.fn(async () => null),
  };
}

function makeMockPrisma(): InMemoryPrisma {
  const user = makeQueryModel();
  const affiliate = makeQueryModel();
  const referral = makeQueryModel();
  const referralClick = {
    create: vi.fn(async ({ data }: { data?: unknown }) => ({ id: 'click-id', ...(data ?? {}) })),
    findMany: vi.fn(async () => []),
    update: vi.fn(async (params: { data?: unknown }) => ({ id: 'click-id', ...(params?.data ?? {}) })),
    count: vi.fn(async () => 0),
  };

  const conversion = {
    ...makeQueryModel(),
    findFirst: vi.fn(async () => null),
    update: vi.fn(async (params: { data?: unknown }) => ({ id: 'conversion-id', ...(params?.data ?? {}) })),
  };

  const commission = {
    ...makeQueryModel(),
    findFirst: vi.fn(async () => null),
    update: vi.fn(async (params: { data?: unknown }) => ({ id: 'commission-id', ...(params?.data ?? {}) })),
  };

  const payout = {
    ...makeQueryModel(),
    findMany: vi.fn(async () => []),
    update: vi.fn(async (params: { data?: unknown }) => ({ id: 'payout-id', ...(params?.data ?? {}) })),
    updateMany: vi.fn(async () => ({ count: 0 })),
  };

  const apiKey = {
    findMany: vi.fn(async () => []),
    create: vi.fn(async (params: { data?: unknown }) => ({ id: 'api-key-id', ...(params?.data ?? {}) })),
    findFirst: vi.fn(async () => null),
    findUnique: vi.fn(async () => null),
    update: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 0 })),
    delete: vi.fn(async ({ where }: { where?: unknown }) => ({ id: (where as { id?: string })?.id || 'api-key-id' })),
  };

  const rateLimitEntry = {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    aggregate: vi.fn(async () => ({ _sum: { requestCount: 0 } })),
    upsert: vi.fn(async () => ({})),
  };

  const integrationSettings = {
    create: vi.fn(async ({ data }: { data?: unknown }) => ({ id: 'integration-id', ...(data ?? {}) })),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    update: vi.fn(async (params: { data?: unknown }) => ({ id: 'integration-id', ...(params?.data ?? {}) })),
    delete: vi.fn(async ({ where }: { where?: { userId?: string } }) => ({
      id: 'integration-id',
      ...(where || {}),
    })),
  };

  const mockPrisma: InMemoryPrisma = {
    $transaction: vi.fn(async (callback: (tx: InMemoryPrisma) => Promise<unknown>) => callback(mockPrisma)),
    db: {
      getAffiliateByReferralCode: vi.fn(async () => null),
      getAffiliateByUserId: vi.fn(async () => null),
      getPlatformSettings: vi.fn(async () => null),
      getProgramSettings: vi.fn(async () => null),
    },
    user,
    affiliate: {
      ...affiliate,
      create: vi.fn(async ({ data }: { data?: unknown }) => ({ id: 'mock-affiliate-id', ...(data ?? {}) })),
      update: vi.fn(async (params: { data?: unknown }) => ({ id: 'mock-affiliate-id', ...(params?.data ?? {}) })),
      updateMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    oTP: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data?: unknown }) => ({ id: 'otp-id', ...(data ?? {}) })),
      update: vi.fn(async () => ({ id: 'otp-id' })),
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    rateLimitEntry,
    referral,
    integrationSettings,
    apiKey,
    payout,
    commission,
    conversion,
    commissionRule: {
      ...makeQueryModel(),
    },
    referralClick,
    auditLog: {
      create: vi.fn(async () => ({ id: 'audit-id' })),
    },
    resource: {
      findMany: vi.fn(async () => []),
      update: vi.fn(async (params: { data?: unknown }) => ({ id: 'resource-id', ...(params?.data ?? {}) })),
    },
    partnerGroup: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data?: unknown }) => ({ id: 'group-id', ...(data ?? {}) })),
      update: vi.fn(async (params: { data?: unknown }) => ({ id: 'group-id', ...(params?.data ?? {}) })),
      updateMany: vi.fn(async () => ({ count: 0 })),
      delete: vi.fn(async () => ({ id: 'group-id' })),
      count: vi.fn(async () => 0),
    },
    transaction: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data?: unknown }) => ({ id: 'transaction-id', ...(data ?? {}) })),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async (params: { data?: unknown }) => ({ id: 'transaction-id', ...(params?.data ?? {}) })),
      delete: vi.fn(async () => ({ id: 'transaction-id' })),
    },
    programSettings: {
      create: vi.fn(async ({ data }: { data?: unknown }) => ({ id: 'program-settings-id', ...(data ?? {}) })),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
    },
    rateLimit: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data?: unknown }) => ({ id: 'rate-limit-id', ...(data ?? {}) })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    apiUsageLog: {
      create: vi.fn(async () => ({ id: 'api-usage-id' })),
    },
    emailTemplate: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data?: unknown }) => ({ id: 'template-id', ...(data ?? {}) })),
      update: vi.fn(async ({ data }: { data?: unknown }) => ({ id: 'template-id', ...(data ?? {}) })),
      updateMany: vi.fn(async () => ({ count: 0 })),
      delete: vi.fn(async () => ({ id: 'template-id' })),
    },
    emailLog: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
  };

  return mockPrisma;
}

export function createMockPrisma(): InMemoryPrisma {
  const instance = makeMockPrisma();

  return instance;
}

export function resetPrismaMock(prisma: InMemoryPrisma) {
  const methodGroups = [
    prisma.user,
    prisma.affiliate,
    prisma.oTP,
    prisma.rateLimitEntry,
    prisma.referral,
    prisma.integrationSettings,
    prisma.apiKey,
    prisma.payout,
    prisma.commission,
    prisma.conversion,
    prisma.commissionRule,
    prisma.referralClick,
    prisma.resource,
    prisma.partnerGroup,
    prisma.auditLog,
    prisma.transaction,
    prisma.programSettings,
    prisma.rateLimit,
    prisma.apiUsageLog,
    prisma.emailTemplate,
    prisma.emailLog,
  ];

  methodGroups.forEach((group) => {
    Object.values(group).forEach((method) => {
      if (typeof method === 'function' && 'mockReset' in method) {
        method.mockReset();
      }
    });
  });

  Object.values(prisma.db).forEach((method) => {
    if (typeof method === 'function' && 'mockReset' in method) {
      method.mockReset();
    }
  });

  prisma.$transaction.mockReset();
}
