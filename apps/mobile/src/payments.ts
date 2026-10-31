import type { PaymentMethod } from "./types";
let providerCard = { providerMode: null as string | null, available: false, mode: null as "test" | "live" | null };
export function configurePaymentChoices(providerMode: string | null, cardAvailable: boolean, stripeMode: "test" | "live" | null) { providerCard = { providerMode, available: cardAvailable, mode: stripeMode }; }

export interface PaymentChoice { id: PaymentMethod | "apple_pay"; label: string; description: string; available: boolean }

export const paymentChoices = (cashEnabled: boolean, cardAvailable = providerCard.available, stripeMode: "test" | "live" | null = providerCard.mode): PaymentChoice[] => [
  cardAvailable ? { id: "card", label: "Card", description: `Secure card checkout.${stripeMode === "live" ? "" : " Test payment · no real money moves."}`, available: true } : providerCard.providerMode === "local_simulator" ? { id: "mock_card", label: "Mock card", description: "Local simulation only. No card is charged.", available: true } : { id: "card", label: "Card unavailable", description: "Provider capability could not be confirmed.", available: false },
  { id: "cash", label: "Cash", description: "Pay the restaurant directly.", available: cashEnabled },
  { id: "apple_pay", label: "Apple Pay", description: "Unavailable until merchant, provider and Apple entitlements are verified.", available: false }
];

export function checkoutPayment(id: PaymentChoice["id"]): PaymentMethod {
  if (id === "apple_pay") throw new Error("Apple Pay is not enabled for this development build.");
  return id;
}
