import { Prisma } from '@prisma/client';

export const REFERRAL_STATES = {
  CLICK: 'CLICK',
  LEAD: 'LEAD',
  CONVERSION: 'CONVERSION',
} as const;

export type ReferralFlowState = typeof REFERRAL_STATES[keyof typeof REFERRAL_STATES];

type TransitionHistoryItem = {
  state: ReferralFlowState;
  source: string;
  actor: string;
  at: string;
};

type ExistingHistory = unknown;

type ReferralStateSource = {
  state: ReferralFlowState;
  source: string;
};

type ReferralFlowMetadataInput = {
  history?: ExistingHistory;
  existingMetadata?: unknown;
};

function toJsonObject(value: unknown): Prisma.InputJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Prisma.InputJsonObject;
}

function normalizeHistory(value: unknown): TransitionHistoryItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Record<string, unknown>;
      if (
        typeof candidate.state === 'string' &&
        typeof candidate.source === 'string' &&
        typeof candidate.actor === 'string' &&
        typeof candidate.at === 'string'
      ) {
        return {
          state: candidate.state as ReferralFlowState,
          source: candidate.source,
          actor: candidate.actor,
          at: candidate.at,
        };
      }
      return null;
    })
    .filter((entry): entry is TransitionHistoryItem => entry !== null);
}

function getExistingMetadata({
  existingMetadata,
  history,
  state,
  source,
}: ReferralStateSource & ReferralFlowMetadataInput): Prisma.InputJsonObject {
  const base = toJsonObject(existingMetadata);
  const lastUpdated = new Date().toISOString();
  const currentHistory = normalizeHistory(history);
  const nextEntry: TransitionHistoryItem = {
    state,
    source,
    actor: 'system',
    at: lastUpdated,
  };

  return {
    ...base,
    _referralFlowState: state,
    _referralFlowSource: source,
    _referralFlowUpdatedAt: lastUpdated,
    _referralFlowHistory: [...currentHistory, nextEntry],
  };
}

export function buildReferralStateMetadata(
  metadata: unknown,
  state: ReferralFlowState,
  source: string,
): Prisma.InputJsonObject {
  const base = toJsonObject(metadata);
  const existingHistory = normalizeHistory(base._referralFlowHistory);

  return getExistingMetadata({
    state,
    source,
    existingMetadata: base,
    history: existingHistory,
  });
}

export function resolveReferralStateTransition(
  currentState: ReferralFlowState | null | undefined,
  incomingState: ReferralFlowState,
): ReferralFlowState {
  if (!currentState) {
    return incomingState;
  }
  if (currentState === REFERRAL_STATES.CONVERSION) {
    return REFERRAL_STATES.CONVERSION;
  }
  if (currentState === REFERRAL_STATES.LEAD && incomingState === REFERRAL_STATES.CLICK) {
    return REFERRAL_STATES.LEAD;
  }
  return incomingState;
}

export function getReferralFlowState(metadata: unknown): ReferralFlowState | null {
  const base = toJsonObject(metadata);
  if (typeof base._referralFlowState !== 'string') {
    return null;
  }
  if (Object.values(REFERRAL_STATES).includes(base._referralFlowState as ReferralFlowState)) {
    return base._referralFlowState as ReferralFlowState;
  }
  return null;
}
