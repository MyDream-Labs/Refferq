import { prisma } from './prisma';
import type { PrismaClient } from '@prisma/client';

const DEFAULT_PROGRAM_SETTINGS = {
  currency: 'USD',
  productName: 'Affiliate Program',
  programName: 'Refferq Affiliate Program',
  websiteUrl: 'https://app.refferq.com',
  portalSubdomain: 'app',
  minimumPayoutThreshold: 0,
  minPayoutCents: 100000,
  payoutTerm: 'NET-15',
  commissionHoldDays: 30,
  payoutFrequency: 'MONTHLY',
  autoApprovePayouts: false,
  autoApprove: false,
  payoutMethods: ['PAYPAL'],
} as const;

export type ProgramSettingsSnapshot = {
  id: string;
  currency: string;
  productName: string;
  programName: string;
  websiteUrl: string;
  portalSubdomain: string;
  minimumPayoutThreshold: number;
  minPayoutCents: number;
  payoutTerm: string;
  commissionHoldDays: number;
  payoutFrequency: string;
  autoApprovePayouts: boolean;
  autoApprove: boolean;
  payoutMethods: string[];
};

function resolveMinPayoutCents(raw: {
  minPayoutCents?: number | null;
  minimumPayoutThreshold?: number | null;
}): number {
  if (typeof raw.minPayoutCents === 'number' && Number.isFinite(raw.minPayoutCents)) {
    return Math.max(0, raw.minPayoutCents);
  }

  if (typeof raw.minimumPayoutThreshold === 'number' && Number.isFinite(raw.minimumPayoutThreshold)) {
    return Math.max(0, raw.minimumPayoutThreshold);
  }

  return DEFAULT_PROGRAM_SETTINGS.minPayoutCents;
}

type ProgramSettingsRecord = {
  id?: string;
  currency?: string | null;
  productName?: string | null;
  programName?: string | null;
  websiteUrl?: string | null;
  portalSubdomain?: string | null;
  minimumPayoutThreshold?: number | null;
  minPayoutCents?: number | null;
  payoutTerm?: string | null;
  commissionHoldDays?: number | null;
  payoutFrequency?: string | null;
  autoApprovePayouts?: boolean | null;
  payoutMethods?: unknown;
};

type ProgramSettingsClient = {
  programSettings: {
    findFirst: (args?: unknown) => Promise<ProgramSettingsRecord | null>;
  };
};

const defaultProgramSettingsClient: ProgramSettingsClient = {
  programSettings: {
    findFirst: async (args?: unknown) =>
      (await prisma.programSettings.findFirst(args as never)) as ProgramSettingsRecord | null,
  },
};

export async function getProgramSettings(
  client: ProgramSettingsClient = defaultProgramSettingsClient
): Promise<ProgramSettingsSnapshot> {
  const programSettings = await client.programSettings.findFirst();
  const id = programSettings?.id || `fallback_${Date.now()}`;
  const payoutMethods: string[] = Array.isArray(programSettings?.payoutMethods)
    ? programSettings.payoutMethods.filter((method): method is string => typeof method === 'string')
    : [...DEFAULT_PROGRAM_SETTINGS.payoutMethods];

  return {
    id,
    currency: programSettings?.currency || DEFAULT_PROGRAM_SETTINGS.currency,
    productName: programSettings?.productName || DEFAULT_PROGRAM_SETTINGS.productName,
    programName: programSettings?.programName || DEFAULT_PROGRAM_SETTINGS.programName,
    websiteUrl: programSettings?.websiteUrl || DEFAULT_PROGRAM_SETTINGS.websiteUrl,
    portalSubdomain: programSettings?.portalSubdomain || DEFAULT_PROGRAM_SETTINGS.portalSubdomain,
    minimumPayoutThreshold: Number(programSettings?.minimumPayoutThreshold ?? 0),
    minPayoutCents: resolveMinPayoutCents(programSettings ?? {}),
    payoutTerm: programSettings?.payoutTerm || DEFAULT_PROGRAM_SETTINGS.payoutTerm,
    commissionHoldDays: programSettings?.commissionHoldDays ?? DEFAULT_PROGRAM_SETTINGS.commissionHoldDays,
    payoutFrequency: programSettings?.payoutFrequency || DEFAULT_PROGRAM_SETTINGS.payoutFrequency,
    autoApprovePayouts: programSettings?.autoApprovePayouts ?? DEFAULT_PROGRAM_SETTINGS.autoApprovePayouts,
    autoApprove: programSettings?.autoApprovePayouts ?? false,
    payoutMethods,
  };
}
