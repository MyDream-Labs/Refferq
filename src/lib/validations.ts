import { z } from 'zod';

const estimatedValueInput = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }
    return Number(normalized);
  }

  return value;
}, z.number().min(0).max(999999999).optional());

// Referral Validation
const canonicalReferralPayloadSchema = z.object({
  leadName: z.string().min(2, 'Name must be at least 2 characters').trim(),
  leadEmail: z.string().trim().toLowerCase().email('Invalid email address'),
  company: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  estimatedValue: estimatedValueInput,
});

const legacyReferralPayloadSchema = z.object({
  lead_name: z.string().min(2, 'Name must be at least 2 characters').trim(),
  lead_email: z.string().trim().toLowerCase().email('Invalid email address'),
  company: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  estimated_value: estimatedValueInput,
});

export const referralSchema = z.union([
  canonicalReferralPayloadSchema,
  legacyReferralPayloadSchema,
]).transform((payload) => {
  if ('leadName' in payload) {
    return {
      leadName: payload.leadName,
      leadEmail: payload.leadEmail,
      company: payload.company,
      notes: payload.notes,
      estimatedValue: payload.estimatedValue,
    };
  }

  return {
    leadName: payload.lead_name,
    leadEmail: payload.lead_email,
    company: payload.company,
    notes: payload.notes,
    estimatedValue: payload.estimated_value,
  };
});

// Affiliate Creation Validation (Admin)
export const affiliateCreateSchema = z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters').optional(),
});

// Payout Validation
export const payoutSchema = z.object({
    affiliateId: z.string(),
    commissionIds: z.array(z.string()).min(1, 'At least one commission is required'),
    method: z.string().optional(),
    notes: z.string().optional(),
});

// Payout Status Update Validation
export const payoutUpdateSchema = z.object({
    id: z.string(),
    status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED']).optional(),
    method: z.string().optional(),
    notes: z.string().optional(),
});

export const trackReferralSchema = z.object({
  referralCode: z.string().trim().min(3).max(128),
  url: z.string().url().optional(),
  referrer: z.string().trim().optional(),
  userAgent: z.string().trim().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  timestamp: z.string().optional(),
});

const conversionTypeValues = ['SIGNUP', 'PURCHASE', 'TRIAL', 'LEAD'] as const;

const amountFromPayload = z
  .union([z.number(), z.string()])
  .transform((value) => {
    if (typeof value === 'number') return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : NaN;
  })
  .pipe(z.number().finite());

function requireAmount(value: {
  amount?: number;
  amountCents?: number;
}) {
  return value.amount !== undefined || value.amountCents !== undefined;
}

// --- Tracking payloads ---
export const trackConversionSchema = z
  .object({
    referralCode: z.string().trim().min(3).max(128),
    customerEmail: z.string().trim().toLowerCase().email(),
    customerName: z.string().trim().min(2).max(255).optional(),
    amount: amountFromPayload.optional(),
    amountCents: z.number().int().nonnegative().optional(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .length(3, { message: 'currency must be a 3-letter ISO code' })
      .optional()
      .default('USD'),
    eventType: z
      .enum(conversionTypeValues)
      .optional()
      .default('PURCHASE'),
    orderId: z.string().trim().optional(),
    eventId: z.string().trim().optional(),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
    url: z.string().url().optional(),
    timestamp: z.string().optional(),
    customerPhone: z.string().trim().optional(),
  })
  .superRefine((value, ctx) => {
    if (!requireAmount(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount'],
        message: 'Either amount or amountCents is required',
      });
      return;
    }

    if (!value.orderId && !value.eventId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['orderId'],
        message: 'Either orderId or eventId is required',
      });
    }
  });

export const webhookConversionSchema = z
  .object({
    event_type: z.enum(conversionTypeValues),
    eventId: z.string().trim().optional(),
    order_id: z.string().trim().optional(),
    customer_email: z.string().trim().toLowerCase().email(),
    customerEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email()
      .optional(),
    amount_cents: z.number().int().nonnegative().optional(),
    amount: amountFromPayload.optional(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .length(3, { message: 'currency must be a 3-letter ISO code' })
      .optional()
      .default('USD'),
    referral_code: z.string().trim().optional(),
    attribution_key: z.string().trim().optional(),
    event_metadata: z.record(z.string(), z.unknown()).optional().default({}),
    timestamp: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.eventId && !value.order_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eventId'],
        message: 'Either eventId or order_id is required',
      });
    }

    if (value.amount_cents === undefined && value.amount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount_cents'],
        message: 'Either amount_cents or amount is required',
      });
    }

    if (!value.referral_code && !value.attribution_key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['referral_code'],
        message: 'At least one of referral_code or attribution_key is expected for attribution context',
      });
    }
  });

export const webhookRefundSchema = z
  .object({
    event_type: z.string().trim().optional(),
    eventId: z.string().trim().optional(),
    external_id: z.string().trim().optional(),
    refund_id: z.string().trim().optional(),
    customer_email: z.string().trim().toLowerCase().email(),
    referral_code: z.string().trim().optional(),
    amount_cents: z.number().int().nonnegative().optional(),
    amount: amountFromPayload.optional(),
    reason: z.string().trim().optional(),
    timestamp: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.eventId && !value.external_id && !value.refund_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['external_id'],
        message: 'One of eventId, external_id, or refund_id is required',
      });
    }

    if (value.amount_cents === undefined && value.amount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amount_cents'],
        message: 'Either amount_cents or amount is required',
      });
    }
  });

export type TrackConversionPayload = z.infer<typeof trackConversionSchema>;
export type WebhookConversionPayload = z.infer<typeof webhookConversionSchema>;

// Program Settings Validation
export const programSettingsSchema = z.object({
    productName: z.string().min(1),
    programName: z.string().min(1),
    websiteUrl: z.string().url(),
    currency: z.string().length(3),
    minPayoutCents: z.number().min(0),
    cookieDuration: z.number().int().min(1),
});
