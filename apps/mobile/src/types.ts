export type Fulfillment = "delivery" | "collection";
export type PaymentMethod = "mock_card" | "cash";

export interface User {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  role: "customer";
}

export interface Address {
  id?: string;
  label: string;
  line1: string;
  line2?: string;
  city: string;
  postcode: string;
}

export interface Restaurant {
  id: string;
  name: string;
  coverImageUrl?: string | null;
  acceptingOrders: boolean;
  closedReason?: string | null;
  suspended: boolean;
  delivery: {
    enabled: boolean;
    outcodes: string[];
    deliveryFeeMinor: number;
    minDeliverySubtotalMinor: number;
  };
  profile: {
    description?: string;
    cuisine?: string;
    collectionEnabled: boolean;
    cashEnabled: boolean;
    paused: boolean;
    estimatedDeliveryMinutes?: number;
    estimatedCollectionMinutes?: number;
  };
}

export interface ModifierOption { id: string; name: string; priceMinor: number; available: boolean }
export interface ModifierGroup { id: string; name: string; minSelections: number; maxSelections: number; options: ModifierOption[] }
export interface MenuItem {
  id: string;
  restaurantId: string;
  name: string;
  description: string;
  priceMinor: number;
  available: boolean;
  category: string;
  allergens: string[];
  dietaryTags: string[];
  modifierGroups: ModifierGroup[];
  photoUrl?: string | null;
}
export type Selections = Record<string, string[]>;
export interface CartEntry { item: MenuItem; quantity: number; selections: Selections }

export interface OrderItem {
  id: string;
  menuItemId: string;
  name: string;
  quantity: number;
  basePriceMinor: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  allergens: string[];
  selectedModifiers: Array<{ groupId: string; optionId: string; name: string; priceMinor: number }>;
  isOfferItem?: boolean;
}
export interface Order {
  id: string;
  restaurantId: string;
  restaurantName: string;
  restaurantPhone?: string | null;
  messagingAvailable?: boolean;
  messagingClosesAt?: string | null;
  grossFoodMinor?: number;
  restaurantDiscountMinor?: number;
  status: string;
  estimatedReadyAt?: string | null;
  currency: "GBP";
  subtotalMinor: number;
  deliveryFeeMinor: number;
  totalMinor: number;
  paymentMethod: PaymentMethod;
  paymentStatus: string;
  fulfillment: Fulfillment;
  deliveryAddress?: Address | null;
  items: OrderItem[];
  events: Array<{ id: string; kind: string; fromStatus?: string; toStatus?: string; createdAt: string }>;
  refundedTotalMinor?: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationRecord {
  id: string;
  title: string;
  message: string;
  type: string;
  readAt?: string | null;
  orderId?: string | null;
  offerId?: string | null;
  createdAt: string;
}
export interface Offer {
  offerType?: "free_item" | "percent_off" | "fixed_off";
  value?: number;
  id: string;
  title: string;
  message: string;
  restaurantId: string;
  restaurantName: string;
  itemName: string;
  minSubtotalMinor: number;
  expiresAt: string;
  status: string;
  viewedAt?: string | null;
}
export interface RefundCase {
  phase?: string;
  id: string;
  reference: string;
  orderId: string;
  restaurantId: string;
  status: string;
  reason: string;
  description: string;
  itemIds: string[];
  requestedAmountMinor: number;
  approvedAmountMinor?: number | null;
  evidence: Array<{ id: string; mimeType: string; byteLength: number; url: string; createdAt: string }>;
  messages: Array<{ id: string; audience: string; message: string; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
}
export interface SupportCase { id: string; orderId?: string | null; subject: string; message: string; status: string; createdAt: string; updatedAt: string }
export interface Page<T> { items: T[]; nextCursor?: string | null }
