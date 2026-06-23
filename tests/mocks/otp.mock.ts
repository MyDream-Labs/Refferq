import { vi } from 'vitest';

export const otpService = {
  sendOTP: vi.fn(async () => ({ success: true, message: 'OTP sent successfully' })),
  verifyOTP: vi.fn(async () => ({ success: false, message: 'Invalid or expired OTP' })),
};
