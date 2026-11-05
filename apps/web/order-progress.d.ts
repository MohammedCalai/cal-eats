export function customerOrderProgress(order: { fulfillment: string; status: string }): {
  steps: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  index: number;
};
