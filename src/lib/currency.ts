import { getProgramSettings } from './program-settings';

const UNIFIED_SYMBOL = '$';

export async function getCurrencySymbol(): Promise<string> {
  try {
    const settings = await getProgramSettings();
    return settings.currency && settings.currency.toUpperCase() === 'INR' ? UNIFIED_SYMBOL : UNIFIED_SYMBOL;
  } catch (_error) {
    return UNIFIED_SYMBOL;
  }
}

export function formatCurrency(cents: number, _symbol: string = UNIFIED_SYMBOL): string {
  const amount = cents / 100;
  return `${UNIFIED_SYMBOL}${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export async function formatAmount(cents: number): Promise<string> {
  await getCurrencySymbol();
  return formatCurrency(cents, UNIFIED_SYMBOL);
}
