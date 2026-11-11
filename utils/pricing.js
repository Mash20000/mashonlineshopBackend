// The price a customer actually pays: the offer price while a product is on offer, otherwise the normal price.
export const effectivePrice = (p) =>
  p.onOffer && Number(p.offerPrice) > 0 && Number(p.offerPrice) < Number(p.price) ? Number(p.offerPrice) : Number(p.price);

export const optionsText = (chosen = []) =>
  chosen.length ? ` (${chosen.map((o) => `${o.name}: ${o.value}`).join(', ')})` : '';

// A product with this many items (or fewer) left counts as "low stock"
export const LOW_STOCK = 5;
