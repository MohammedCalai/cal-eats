export type CheckoutAttemptRecord = Readonly<{ key: string; serializedBody: string }>;
export function isDefiniteNoOrderError(error: unknown): boolean;
export function createCheckoutAttempt(createKey: () => string): {
  readonly pending: CheckoutAttemptRecord | null;
  clear(): void;
  submit<T extends { id: string }>(body: object | null | undefined, send: (record: CheckoutAttemptRecord) => Promise<T>): Promise<T>;
};
