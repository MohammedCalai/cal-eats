const deliverySteps = Object.freeze([
  { id: "placed", label: "Placed" },
  { id: "accepted", label: "Confirmed" },
  { id: "preparing", label: "Preparing" },
  { id: "out_for_delivery", label: "On the way" },
  { id: "completed", label: "Delivered" }
].map(Object.freeze));
const collectionSteps = Object.freeze([
  { id: "placed", label: "Placed" },
  { id: "accepted", label: "Confirmed" },
  { id: "preparing", label: "Preparing" },
  { id: "ready", label: "Ready" },
  { id: "completed", label: "Collected" }
].map(Object.freeze));

export function customerOrderProgress(order) {
  const delivery = order.fulfillment === "delivery";
  const steps = delivery ? deliverySteps : collectionSteps;
  const visibleStatus = delivery && order.status === "ready" ? "preparing" : order.status;
  return { steps, index: steps.findIndex(step => step.id === visibleStatus) };
}
