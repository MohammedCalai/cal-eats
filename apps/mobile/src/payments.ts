import type { PaymentMethod } from "./types";

export interface PaymentChoice { id: PaymentMethod | "apple_pay"; label: string; description: string; available: boolean }

export const paymentChoices = (cashEnabled: boolean): PaymentChoice[] => [
  { id: "mock_card", label: "Mock card", description: "Local simulation only. No card is charged.", available: true },
  { id: "cash", label: "Cash", description: "Pay the restaurant directly.", available: cashEnabled },
  { id: "apple_pay", label: "Apple Pay", description: "Unavailable until merchant, provider and Apple entitlements are verified.", available: false }
];

export function checkoutPayment(id: PaymentChoice["id"]): PaymentMethod {
  if (id === "apple_pay") throw new Error("Apple Pay is not enabled for this development build.");
  return id;
}
