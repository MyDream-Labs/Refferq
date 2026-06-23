import { vi } from 'vitest';

const successResponse = { success: true, message: 'Email sent successfully' };
const resendSendResponse = { id: 'mock-email-id' };

export const emailService = {
  sendWelcomeEmail: vi.fn(async () => successResponse),
  sendReferralNotification: vi.fn(async () => successResponse),
  sendApprovalEmail: vi.fn(async () => successResponse),
  sendPayoutNotification: vi.fn(async () => successResponse),
  sendConversionNotification: vi.fn(async () => successResponse),
  sendCommissionNotification: vi.fn(async () => successResponse),
  sendPasswordResetEmail: vi.fn(async () => successResponse),
  sendVerificationEmail: vi.fn(async () => successResponse),
  sendTransactionCreatedEmail: vi.fn(async () => successResponse),
  sendPayoutCreatedEmail: vi.fn(async () => successResponse),
  sendPayoutCompletedEmail: vi.fn(async () => successResponse),
  sendCustomEmail: vi.fn(async () => successResponse),
  sendGenericEmail: vi.fn(async () => successResponse),
};

export const resend = {
  emails: {
    send: vi.fn(async () => resendSendResponse),
  },
};

export const resetEmailMocks = () => {
  Object.values(emailService).forEach((fn) => {
    if (typeof fn === 'function' && 'mockReset' in fn) {
      fn.mockReset();
    }
  });

  resend.emails.send.mockReset();
};
