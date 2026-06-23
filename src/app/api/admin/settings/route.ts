import { NextRequest, NextResponse } from 'next/server';
import { Prisma, UserStatus } from '@prisma/client';
import { revalidateTag } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { logAuditAction } from '@/lib/audit';
import { getProgramSettings, type ProgramSettingsSnapshot } from '@/lib/program-settings';

type AdminAuthState =
  | { ok: true; id: string; status: UserStatus }
  | { ok: false; error: string; status: number };

function normalizeCommissionRuleInput(value: unknown): Prisma.CommissionRuleCreateInput {
  if (!value || typeof value !== 'object') {
    return {
      name: '',
      type: 'PERCENTAGE',
      value: 0,
      isDefault: false,
      isActive: true,
    };
  }

  const raw = value as Record<string, unknown>;
  return {
    name: typeof raw.name === 'string' ? raw.name : '',
    type: raw.type === 'FIXED' ? 'FIXED' : 'PERCENTAGE',
    value: typeof raw.value === 'number' && Number.isFinite(raw.value) ? raw.value : 0,
    conditions:
      raw.conditions && typeof raw.conditions === 'object' && !Array.isArray(raw.conditions)
        ? raw.conditions
        : {},
    isDefault: raw.isDefault === true,
    isActive: raw.isActive !== false,
  };
}

function buildProgramSettingsDefaults(): Prisma.ProgramSettingsCreateInput {
  return {
    programId: `prg_${Date.now()}`,
    productName: 'Affiliate Program',
    programName: 'Refferq Affiliate Program',
    websiteUrl: 'https://app.refferq.com',
    currency: 'USD',
    portalSubdomain: 'app',
    minimumPayoutThreshold: 0,
    payoutTerm: 'NET-15',
    commissionHoldDays: 30,
    payoutFrequency: 'MONTHLY',
    autoApprovePayouts: false,
    minPayoutCents: 100000,
    payoutMethods: ['PAYPAL'],
  };
}

async function getOrCreateProgramSettings() {
  const existing = await prisma.programSettings.findFirst();
  if (existing) return existing;

  return prisma.programSettings.create({
    data: buildProgramSettingsDefaults(),
  });
}

function mapSettingsSnapshotForApi(settings: ProgramSettingsSnapshot) {
  return {
    ...settings,
    minimumPayoutThreshold: settings.minPayoutCents,
  };
}

async function verifyAdmin(request: NextRequest): Promise<AdminAuthState> {
  const userId = request.headers.get('x-user-id');
  if (!userId) {
    return { ok: false, error: 'Unauthorized', status: 401 };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true },
  });

  if (!user || user.role !== 'ADMIN') {
    return { ok: false, error: 'Access denied. Admin role required.', status: 403 };
  }

  if (user.status !== UserStatus.ACTIVE) {
    return { ok: false, error: 'Account is inactive or pending approval', status: 403 };
  }

  return { ok: true, id: user.id, status: user.status };
}

function buildSettingsUpdate(data: Record<string, unknown>) {
  const update: Prisma.ProgramSettingsUpdateInput = {};

  if (typeof data.productName === 'string' && data.productName.trim()) {
    update.productName = data.productName.trim();
  }
  if (typeof data.programName === 'string' && data.programName.trim()) {
    update.programName = data.programName.trim();
  }
  if (typeof data.websiteUrl === 'string' && data.websiteUrl.trim()) {
    update.websiteUrl = data.websiteUrl.trim();
  }
  if (typeof data.currency === 'string' && data.currency.trim()) {
    update.currency = data.currency.trim().toUpperCase();
  }
  if (typeof data.portalSubdomain === 'string' && data.portalSubdomain.trim()) {
    update.portalSubdomain = data.portalSubdomain.trim();
  }

  const minPayout =
    typeof data.minPayoutCents === 'number' && Number.isFinite(data.minPayoutCents)
      ? data.minPayoutCents
      : typeof data.minimumPayoutThreshold === 'number' && Number.isFinite(data.minimumPayoutThreshold)
        ? data.minimumPayoutThreshold
        : null;
  if (minPayout !== null) {
    update.minPayoutCents = Math.max(0, Math.trunc(minPayout));
  }

  if (typeof data.payoutTerm === 'string' && data.payoutTerm.trim()) {
    update.payoutTerm = data.payoutTerm.trim();
  }

  if (typeof data.commissionHoldDays === 'number' && Number.isFinite(data.commissionHoldDays)) {
    update.commissionHoldDays = Math.max(1, Math.trunc(data.commissionHoldDays));
  }

  if (typeof data.payoutFrequency === 'string' && data.payoutFrequency.trim()) {
    update.payoutFrequency = data.payoutFrequency.trim().toUpperCase();
  }

  if (typeof data.autoApprove === 'boolean') {
    update.autoApprovePayouts = data.autoApprove;
  }
  if (typeof data.autoApprovePayouts === 'boolean') {
    update.autoApprovePayouts = data.autoApprovePayouts;
  }

  if (Array.isArray(data.payoutMethods)) {
    update.payoutMethods = data.payoutMethods
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => String(value).trim());
  }

  if (typeof data.cookieDuration === 'number' && Number.isFinite(data.cookieDuration)) {
    update.cookieDuration = Math.max(1, Math.trunc(data.cookieDuration));
  }

  if (typeof data.blockedCountries !== 'undefined') {
    update.blockedCountries =
      data.blockedCountries && typeof data.blockedCountries === 'object'
        ? data.blockedCountries
        : [];
  }

  return update;
}

function isNoopSettingsUpdate(update: Prisma.ProgramSettingsUpdateInput): boolean {
  return Object.keys(update).length === 0;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdmin(request);
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.status }
      );
    }

    await getOrCreateProgramSettings();
    const settings = await getProgramSettings();

    // Get all commission rules
    const commissionRules = await prisma.commissionRule.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });

    return NextResponse.json({
      success: true,
      settings: {
        ...mapSettingsSnapshotForApi(settings),
        commissionRules: commissionRules.map((rule) => ({
          id: rule.id,
          name: rule.name,
          type: rule.type,
          value: rule.value,
          conditions: rule.conditions,
          isDefault: rule.isDefault,
          isActive: rule.isActive,
          createdAt: rule.createdAt,
        })),
      },
    });

  } catch (error) {
    console.error('Settings API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch settings' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await verifyAdmin(request);
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.status }
      );
    }

    const rawBody = await request.json();
    const body = typeof rawBody === 'object' && rawBody !== null ? rawBody as Record<string, unknown> : {};
    const programSettings = await getOrCreateProgramSettings();

    const data = buildSettingsUpdate(body);
    if (isNoopSettingsUpdate(data)) {
      const settings = await getProgramSettings();
      return NextResponse.json({
        success: true,
        settings: mapSettingsSnapshotForApi(settings),
        message: 'No changes to update',
      });
    }

    const updatedSettings = await prisma.programSettings.update({
      where: { id: programSettings.id },
      data,
    });

    const normalizedUpdatedSettings = await getProgramSettings({
      programSettings: {
        findFirst: async () => updatedSettings,
      },
    });

    // Log the action
    await logAuditAction({
      actorId: auth.id,
      action: 'UPDATE_SETTINGS',
      objectType: 'PROGRAM_SETTINGS',
      objectId: updatedSettings.id,
      payload: data,
    });

    // Clear cache
    revalidateTag('platform-settings', 'default');
    revalidateTag('program-settings', 'default');

    return NextResponse.json({
      success: true,
      message: 'Settings updated successfully',
      settings: mapSettingsSnapshotForApi(normalizedUpdatedSettings),
    });

  } catch (error) {
    console.error('Settings update API error:', error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdmin(request);
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.error },
        { status: auth.status }
      );
    }

    const body = await request.json();
    const { action, ruleData } = body;

    if (action === 'create') {
      const normalizedRule = normalizeCommissionRuleInput(ruleData);

      if (!normalizedRule.name || !Number.isFinite(normalizedRule.value)) {
        return NextResponse.json(
          { error: 'Name and value are required' },
          { status: 400 }
        );
      }


      // If setting as default, unset other defaults
      if (normalizedRule.isDefault) {
        await prisma.commissionRule.updateMany({
          where: { isDefault: true },
          data: { isDefault: false }
        });
      }

      const newRule = await prisma.commissionRule.create({
        data: {
          name: normalizedRule.name,
          type: normalizedRule.type,
          value: normalizedRule.value,
          conditions: normalizedRule.conditions,
          isDefault: normalizedRule.isDefault,
          isActive: normalizedRule.isActive,
        }
      });

      // Log the action
      await logAuditAction({
        actorId: auth.id,
        action: 'CREATE_COMMISSION_RULE',
        objectType: 'COMMISSION_RULE',
        objectId: newRule.id,
        payload: ruleData
      });

      // Clear cache
      revalidateTag('program-settings', 'default');

      return NextResponse.json({
        success: true,
        message: 'Commission rule created successfully',
        rule: newRule
      });
    }

    if (action === 'update') {
      // Update existing commission rule
      const { id, ...updates } = ruleData;
      const normalizedUpdate =
        updates && typeof updates === 'object'
          ? updates
          : {};

      if (!id) {
        return NextResponse.json(
          { error: 'Rule ID is required for update' },
          { status: 400 }
        );
      }

      // If setting as default, unset other defaults
      if (normalizedUpdate.isDefault) {
        await prisma.commissionRule.updateMany({
          where: {
            id: { not: id },
            isDefault: true
          },
          data: { isDefault: false }
        });
      }

      const updatedRule = await prisma.commissionRule.update({
        where: { id },
        data: normalizedUpdate
      });

      // Clear cache
      revalidateTag('program-settings', 'default');

      return NextResponse.json({
        success: true,
        message: 'Commission rule updated successfully',
        rule: updatedRule
      });
    }

    if (action === 'delete') {
      // Delete commission rule
      const { id } = ruleData;

      if (!id) {
        return NextResponse.json(
          { error: 'Rule ID is required for deletion' },
          { status: 400 }
        );
      }

      await prisma.commissionRule.delete({
        where: { id }
      });

      // Clear cache
      revalidateTag('program-settings', 'default');

      return NextResponse.json({
        success: true,
        message: 'Commission rule deleted successfully'
      });
    }

    return NextResponse.json(
      { error: 'Invalid action' },
      { status: 400 }
    );

  } catch (error) {
    console.error('Settings API error:', error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
