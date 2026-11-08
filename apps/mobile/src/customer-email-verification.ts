export type VerificationDelivery = "email" | "local_simulation" | "unavailable";
export type CustomerEmailVerificationStatus = {
  email: string;
  emailVerified: boolean;
  verificationRequired: boolean;
  canOrder: boolean;
  resendAvailableAt: string | null;
  delivery: VerificationDelivery;
};

export function parseCustomerEmailVerification(value: unknown): CustomerEmailVerificationStatus {
  const row = value as Partial<CustomerEmailVerificationStatus> | null;
  if (!row || typeof row.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) || typeof row.emailVerified !== "boolean" || typeof row.verificationRequired !== "boolean" || typeof row.canOrder !== "boolean" || row.canOrder !== (!row.verificationRequired || row.emailVerified) || !["email", "local_simulation", "unavailable"].includes(row.delivery ?? "") || row.resendAvailableAt !== null && (typeof row.resendAvailableAt !== "string" || !Number.isFinite(Date.parse(row.resendAvailableAt)) || new Date(row.resendAvailableAt).toISOString() !== row.resendAvailableAt)) throw Error("Your email-verification information could not be verified. Please refresh it before ordering.");
  return row as CustomerEmailVerificationStatus;
}

export function verificationCooldownSeconds(status: CustomerEmailVerificationStatus | null, now = Date.now()): number {
  if (!status?.resendAvailableAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(status.resendAvailableAt) - now) / 1000));
}
