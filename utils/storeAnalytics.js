import { effectivePrice, LOW_STOCK } from './pricing.js';

// Pure functions (no database access) that turn products + paid orders into the Store analysis:
// stock status, performance ranking, profit, and a list of plain-language advice for the admin.

const DAY = 86400000;
const kes = (n) => `KES ${Math.round(n).toLocaleString('en-KE')}`;
const num = (v) => Number(v) || 0;
const has = (v) => v !== null && v !== undefined;
const PRIORITY = { high: 0, medium: 1, low: 2 };

/**
 * products: plain product objects (including costPrice)
 * orders:   paid orders [{ items: [{ product, qty, price, cost }] }] inside the chosen period
 * days:     7 | 30 | 90 | 0 (0 = all time)
 */
export function analyzeStore({ products, orders, days, now = Date.now(), pendingDelivery = 0, unreadChats = 0 }) {
  const since = days ? now - days * DAY : 0;

  const stats = new Map(
    products.map((p) => [String(p._id), { product: p, unitsSold: 0, revenue: 0, costTotal: 0, allCostKnown: true }])
  );

  let totalUnits = 0;
  let totalRevenue = 0;
  for (const order of orders) {
    for (const item of order.items || []) {
      const qty = num(item.qty);
      const revenue = num(item.price) * qty;
      totalUnits += qty;
      totalRevenue += revenue;

      const row = stats.get(String(item.product));
      if (!row) continue; // the product was deleted from the shop
      row.unitsSold += qty;
      row.revenue += revenue;
      const cost = has(item.cost) ? item.cost : row.product.costPrice;
      if (has(cost)) row.costTotal += num(cost) * qty;
      else row.allCostKnown = false;
    }
  }

  // ---- one row per product ----
  const rows = [...stats.values()].map(({ product: p, unitsSold, revenue, costTotal, allCostKnown }) => {
    const price = effectivePrice(p);
    const cost = has(p.costPrice) ? num(p.costPrice) : null;
    const profit = unitsSold === 0 ? 0 : allCostKnown ? revenue - costTotal : null;
    const margin = cost !== null && price > 0 ? (price - cost) / price : null;

    // how many days the product has been on sale inside the period
    const startedAt = Math.max(new Date(p.createdAt).getTime() || 0, since);
    const windowDays = Math.max(1, Math.ceil((now - startedAt) / DAY));
    const velocity = unitsSold / windowDays; // items sold per day
    const daysLeft = velocity > 0 ? p.stock / velocity : null;

    let stockStatus = 'ok';
    if (p.stock <= 0) stockStatus = 'out';
    else if (unitsSold > 0 && (p.stock <= LOW_STOCK || daysLeft <= 7)) stockStatus = 'low';

    // enough stock for about 30 days of sales
    const target = velocity > 0 ? Math.ceil(velocity * 30) : 10;
    const restockQty = stockStatus === 'ok' ? 0 : Math.max(target - p.stock, LOW_STOCK);

    return {
      _id: String(p._id),
      name: p.name,
      category: p.category,
      image: p.image,
      price: num(p.price),
      currentPrice: price,
      onOffer: Boolean(p.onOffer) && price < num(p.price),
      offerPrice: has(p.offerPrice) ? p.offerPrice : null,
      costPrice: cost,
      stock: num(p.stock),
      unitsSold,
      revenue: Math.round(revenue),
      profit: profit === null ? null : Math.round(profit),
      margin,
      velocity: Math.round(velocity * 100) / 100,
      daysLeft: daysLeft === null ? null : Math.round(daysLeft * 10) / 10,
      stockStatus,
      restockQty,
      ratingAvg: num(p.ratingAvg),
      ratingCount: num(p.ratingCount),
      createdAt: p.createdAt,
      performance: 'none',
    };
  });

  // ---- performance ranking ----
  const sellers = rows.filter((r) => r.unitsSold > 0);
  // rank by profit when the cost is known for everything that sold, otherwise by revenue
  const basis = sellers.length && sellers.every((r) => r.profit !== null) ? 'profit' : 'revenue';
  const score = (r) => (basis === 'profit' ? r.profit : r.revenue);
  sellers.sort((a, b) => score(b) - score(a));

  const n = sellers.length;
  const topCount = n ? Math.max(1, Math.round(n * 0.2)) : 0;
  const poorCount = n >= 3 ? Math.max(1, Math.round(n * 0.25)) : 0;
  sellers.forEach((r, i) => {
    r.performance = i < topCount ? 'top' : i >= n - poorCount ? 'poor' : 'average';
  });

  // ---- summary ----
  const orderCount = orders.length;
  const profitRows = sellers.filter((r) => r.profit !== null);
  const summary = {
    products: rows.length,
    inStock: rows.filter((r) => r.stock > 0).length,
    lowStock: rows.filter((r) => r.stockStatus === 'low').length,
    outOfStock: rows.filter((r) => r.stockStatus === 'out').length,
    noSales: rows.filter((r) => r.unitsSold === 0).length,
    unitsSold: totalUnits,
    revenue: Math.round(totalRevenue),
    orders: orderCount,
    avgOrderValue: orderCount ? Math.round(totalRevenue / orderCount) : 0,
    avgUnitsPerSeller: n ? Math.round((sellers.reduce((s, r) => s + r.unitsSold, 0) / n) * 10) / 10 : 0,
    stockValue: Math.round(rows.reduce((s, r) => s + r.currentPrice * r.stock, 0)),
    profit: profitRows.length ? Math.round(profitRows.reduce((s, r) => s + r.profit, 0)) : null,
    profitComplete: n > 0 && profitRows.length === n,
    missingCost: rows.filter((r) => r.costPrice === null).length,
    pendingDelivery,
  };

  // ---- categories ----
  const catMap = new Map();
  for (const r of rows) {
    const c = catMap.get(r.category) || { category: r.category, products: 0, unitsSold: 0, revenue: 0 };
    c.products += 1;
    c.unitsSold += r.unitsSold;
    c.revenue += r.revenue;
    catMap.set(r.category, c);
  }
  const categories = [...catMap.values()].sort((a, b) => b.revenue - a.revenue);

  const mostProfitable = sellers.length ? sellers[0] : null;

  const advice = buildAdvice({ rows, sellers, summary, basis, categories, unreadChats, mostProfitable, orderCount });

  return { days, basis, summary, mostProfitable, products: rows, categories, advice };
}

function buildAdvice({ rows, sellers, summary, basis, categories, unreadChats, mostProfitable, orderCount }) {
  const list = [];
  const add = (priority, title, detail, actions = []) => list.push({ priority, title, detail, actions });

  const quickRestock = (r) => ({
    kind: 'quick',
    label: `Add ${r.restockQty} to stock`,
    productId: r._id,
    body: { addStock: r.restockQty },
    done: `Added ${r.restockQty} to "${r.name}"`,
  });
  const editAction = (r) => ({ kind: 'edit', label: 'Edit product', productId: r._id });
  const bySold = (a, b) => b.unitsSold - a.unitsSold;

  // 1. Selling products that are out of stock: lost sales right now
  const out = rows.filter((r) => r.stockStatus === 'out' && r.unitsSold > 0).sort(bySold);
  out.slice(0, 4).forEach((r) =>
    add(
      'high',
      `Restock "${r.name}" now`,
      `It sold ${r.unitsSold} item${r.unitsSold === 1 ? '' : 's'} in this period and is now out of stock, so every visitor who wants it is a lost sale.`,
      [quickRestock(r), editAction(r)]
    )
  );
  if (out.length > 4) add('high', `${out.length - 4} more selling products are out of stock`, 'Open the table and choose "Restock" to see them all.', [{ kind: 'filter', label: 'Show restock list', filter: 'restock' }]);

  // 2. Selling products that will run out soon
  const low = rows.filter((r) => r.stockStatus === 'low').sort(bySold);
  low.slice(0, 4).forEach((r) =>
    add(
      r.performance === 'top' ? 'high' : 'medium',
      `"${r.name}" is running low (${r.stock} left)`,
      r.daysLeft !== null
        ? `At the current pace it lasts about ${Math.max(1, Math.round(r.daysLeft))} more day${Math.round(r.daysLeft) <= 1 ? '' : 's'}. Order about ${r.restockQty} more to cover the next 30 days.`
        : `Only ${r.stock} left. Order about ${r.restockQty} more.`,
      [quickRestock(r), editAction(r)]
    )
  );
  if (low.length > 4) add('medium', `${low.length - 4} more products are running low`, 'See them in the table under "Restock".', [{ kind: 'filter', label: 'Show restock list', filter: 'restock' }]);

  // 3. Loss-making and thin-margin products
  rows
    .filter((r) => r.costPrice !== null && r.currentPrice < r.costPrice && r.unitsSold > 0)
    .slice(0, 3)
    .forEach((r) =>
      add('high', `You are selling "${r.name}" at a loss`, `It sells for ${kes(r.currentPrice)} but costs you ${kes(r.costPrice)}. Every sale loses ${kes(r.costPrice - r.currentPrice)}.`, [
        { kind: 'quick', label: `Raise price to ${kes(Math.ceil(r.costPrice / 0.75))}`, productId: r._id, body: { price: Math.ceil(r.costPrice / 0.75), onOffer: false }, done: `Price of "${r.name}" updated` },
        editAction(r),
      ])
    );
  rows
    .filter((r) => r.margin !== null && r.margin >= 0 && r.margin < 0.15 && r.unitsSold > 0)
    .sort(bySold)
    .slice(0, 3)
    .forEach((r) => {
      const target = Math.ceil(r.costPrice / 0.75); // 25% margin
      if (target <= r.price) return;
      add('medium', `"${r.name}" earns very little per sale`, `Margin is only ${Math.round(r.margin * 100)}%. A price of ${kes(target)} would give a healthier 25% margin.`, [
        { kind: 'quick', label: `Raise price to ${kes(target)}`, productId: r._id, body: { price: target }, done: `Price of "${r.name}" updated` },
        editAction(r),
      ]);
    });

  // 4. The best seller: keep it stocked, promote it, and maybe test a higher price
  if (mostProfitable) {
    const r = mostProfitable;
    const actions = [
      {
        kind: 'announce',
        label: 'Announce to customers',
        text: `Customer favourite: ${r.name} at ${kes(r.currentPrice)}. Open the Products page to see it before it sells out.`,
      },
    ];
    let extra = '';
    if (r.unitsSold >= 5 && r.daysLeft !== null && r.daysLeft <= 10 && !r.onOffer) {
      const raised = Math.round(r.price * 1.05);
      extra = ' Demand is strong and stock is moving fast, so a 5% price rise is a low-risk test.';
      actions.unshift({ kind: 'quick', label: `Raise price 5% to ${kes(raised)}`, productId: r._id, body: { price: raised }, done: `Price of "${r.name}" updated` });
    }
    add(
      'medium',
      `Your ${basis === 'profit' ? 'most profitable' : 'best-selling'} item is "${r.name}"`,
      `It brought in ${kes(r.revenue)}${r.profit !== null ? ` (profit ${kes(r.profit)})` : ''} from ${r.unitsSold} sale${r.unitsSold === 1 ? '' : 's'}. Keep it well stocked and promote it.${extra}`,
      actions
    );
  }

  // 5. Poor performers: a discount can move them
  rows
    .filter((r) => r.performance === 'poor' && r.stock > 0 && !r.onOffer)
    .slice(0, 3)
    .forEach((r) => {
      let offer = Math.round(r.price * 0.85);
      if (r.costPrice !== null) offer = Math.max(offer, Math.ceil(r.costPrice * 1.05)); // never below cost
      if (offer >= r.price) {
        add('low', `"${r.name}" sells slowly`, 'The margin is too thin for a discount. Check the price you buy at, or improve the photo and description.', [editAction(r)]);
        return;
      }
      const text = `New offer! ${r.name} is now on offer at ${kes(offer)} (was ${kes(r.price)}). Open the Products page to get yours before the offer ends.`;
      add('medium', `"${r.name}" sells slowly: try an offer`, `Only ${r.unitsSold} sold. A discount to ${kes(offer)} (${Math.round((1 - offer / r.price) * 100)}% off) can move it, and the offer will slide in your home page.`, [
        { kind: 'quick', label: `Put on offer at ${kes(offer)}`, productId: r._id, body: { onOffer: true, offerPrice: offer }, done: `"${r.name}" is now on offer` },
        { kind: 'announce', label: 'Announce this offer', text },
      ]);
    });

  // 6. Products nobody bought in this period
  const unsold = rows.filter((r) => r.unitsSold === 0 && r.stock > 0 && Date.now() - new Date(r.createdAt).getTime() > 14 * DAY);
  if (unsold.length) {
    add(
      'medium',
      `${unsold.length} product${unsold.length === 1 ? ' has' : 's have'} had no sales in this period`,
      `${unsold.slice(0, 4).map((r) => `"${r.name}"`).join(', ')}${unsold.length > 4 ? ' and more' : ''}. Put them on offer, improve their photos or descriptions, or announce them to your customers.`,
      [{ kind: 'filter', label: 'Show these products', filter: 'none' }]
    );
  }

  // 7. Quality warnings from customer feedback
  rows
    .filter((r) => r.ratingCount >= 2 && r.ratingAvg > 0 && r.ratingAvg <= 3)
    .slice(0, 3)
    .forEach((r) =>
      add('medium', `"${r.name}" has a low rating (${r.ratingAvg}/5)`, 'Read the feedback, fix the problem or replace the supplier. Bad reviews stop new customers from buying.', [
        { kind: 'link', label: 'Read the feedback', to: `/products/${r._id}#reviews` },
      ])
    );

  // 8. Shop-wide advice
  if (summary.pendingDelivery > 0) {
    add('high', `${summary.pendingDelivery} paid order${summary.pendingDelivery === 1 ? ' is' : 's are'} waiting for delivery`, 'Fast delivery means happy customers who come back and leave good reviews.', [
      { kind: 'link', label: 'Open orders', to: '/account' },
    ]);
  }
  if (unreadChats > 0) {
    add('medium', `${unreadChats} customer message${unreadChats === 1 ? ' is' : 's are'} waiting for a reply`, 'A quick answer often turns a question into a sale.', [{ kind: 'link', label: 'Open messages', to: '/messages' }]);
  }
  if (summary.missingCost > 0) {
    add('medium', `Add the buying price for ${summary.missingCost} product${summary.missingCost === 1 ? '' : 's'}`, 'Without the buying price the Store page can only rank by sales, not by real profit. Open the quick edit on a product and fill in "Cost price".', [
      { kind: 'filter', label: 'Show products without cost', filter: 'nocost' },
    ]);
  }
  if (categories[0] && categories[0].revenue > 0 && summary.revenue > 0) {
    const share = Math.round((categories[0].revenue / summary.revenue) * 100);
    add('low', `"${categories[0].category}" is your best category (${share}% of sales)`, 'Add more products in this category: customers who already buy from it are your easiest sales.', [
      { kind: 'link', label: 'Add a product', to: '/products' },
    ]);
  }
  const deadCategory = categories.find((c) => c.products >= 2 && c.unitsSold === 0 && c.category !== categories[0]?.category);
  if (deadCategory) {
    add('low', `Nothing sold in "${deadCategory.category}"`, `You have ${deadCategory.products} products there. Consider an offer on one of them or focus your stock on better categories.`, [
      { kind: 'filter', label: 'Show all products', filter: 'all' },
    ]);
  }
  if (orderCount === 0) {
    add('high', 'No paid orders in this period', 'Send your customers a bulk message, put a few products on offer and share the shop link with friends and on social media.', [
      { kind: 'announce', label: 'Write an announcement', text: 'Mash Online Shop has new products and great prices. Open the Products page to see what is new!' },
    ]);
  }
  if (summary.products < 6) {
    add('low', 'Add more products', 'Shops with more variety sell more. Aim for at least 10 products so customers have a reason to come back.', [{ kind: 'link', label: 'Add a product', to: '/products' }]);
  }

  return list.sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority]).slice(0, 16);
}
