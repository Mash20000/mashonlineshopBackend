import { Router } from 'express';
import Product from '../models/Product.js';
import Order from '../models/Order.js';
import ChatMessage from '../models/ChatMessage.js';
import { protect, adminOnly } from '../middleware/auth.js';
import { analyzeStore } from '../utils/storeAnalytics.js';

const router = Router();
router.use(protect, adminOnly);

// GET /api/analytics/store?days=30   (days: 7, 30, 90 or 0 for all time)
router.get('/store', async (req, res, next) => {
  try {
    const requested = parseInt(req.query.days, 10);
    const days = [7, 30, 90, 0].includes(requested) ? requested : 30;

    const orderFilter = { paymentStatus: 'paid', status: { $ne: 'cancelled' } };
    if (days) orderFilter.createdAt = { $gte: new Date(Date.now() - days * 86400000) };

    const [products, orders, pendingDelivery, unreadChats] = await Promise.all([
      Product.find().select('+costPrice').lean(),
      Order.find(orderFilter).select('items.product items.qty items.price items.cost').lean(),
      Order.countDocuments({ paymentStatus: 'paid', status: 'pending' }),
      ChatMessage.countDocuments({ from: 'customer', readByAdmin: false, deletedForAll: { $ne: true }, hiddenFor: { $ne: 'admin' } }),
    ]);

    res.json(analyzeStore({ products, orders, days, pendingDelivery, unreadChats }));
  } catch (err) {
    next(err);
  }
});

export default router;
