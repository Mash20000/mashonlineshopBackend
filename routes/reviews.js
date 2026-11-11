import { Router } from 'express';
import mongoose from 'mongoose';
import Review from '../models/Review.js';
import Product from '../models/Product.js';
import Order from '../models/Order.js';
import { protect, adminOnly } from '../middleware/auth.js';

const router = Router();

const validId = (id) => mongoose.isValidObjectId(id);

// A customer can only review a product from an order that was marked delivered
const findDeliveredOrder = (userId, productId) =>
  Order.findOne({ user: userId, status: 'delivered', 'items.product': productId }).sort({ deliveredAt: -1 });

const refreshStats = async (productId) => {
  const stats = await Review.aggregate([
    { $match: { product: new mongoose.Types.ObjectId(productId) } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  const avg = stats[0] ? Math.round(stats[0].avg * 10) / 10 : 0;
  const count = stats[0] ? stats[0].count : 0;
  await Product.updateOne({ _id: productId }, { ratingAvg: avg, ratingCount: count });
  return { avg, count };
};

// The logged-in customer's own reviews (used on the Account page)
router.get('/mine', protect, async (req, res, next) => {
  try {
    const reviews = await Review.find({ user: req.user._id }).select('product rating comment');
    res.json(reviews);
  } catch (err) {
    next(err);
  }
});

// All reviews of one product
router.get('/product/:productId', async (req, res, next) => {
  try {
    if (!validId(req.params.productId)) return res.status(404).json({ message: 'Product not found' });
    const reviews = await Review.find({ product: req.params.productId })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('user', 'name');

    const count = reviews.length;
    const avg = count ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10 : 0;
    const distribution = [5, 4, 3, 2, 1].map((star) => ({ star, count: reviews.filter((r) => r.rating === star).length }));

    res.json({
      avg,
      count,
      distribution,
      reviews: reviews.map((r) => ({
        _id: r._id,
        rating: r.rating,
        comment: r.comment,
        name: r.user?.name || 'Customer',
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Can the logged-in customer review this product? (and what did they write before?)
router.get('/product/:productId/eligibility', protect, async (req, res, next) => {
  try {
    if (!validId(req.params.productId)) return res.status(404).json({ message: 'Product not found' });
    if (req.user.role === 'admin') return res.json({ canReview: false, review: null });

    const [order, review] = await Promise.all([
      findDeliveredOrder(req.user._id, req.params.productId),
      Review.findOne({ product: req.params.productId, user: req.user._id }),
    ]);
    res.json({ canReview: !!order, review: review ? { rating: review.rating, comment: review.comment } : null });
  } catch (err) {
    next(err);
  }
});

// Add or update a review
router.post('/product/:productId', protect, async (req, res, next) => {
  try {
    const { productId } = req.params;
    if (!validId(productId)) return res.status(404).json({ message: 'Product not found' });
    if (req.user.role === 'admin') return res.status(403).json({ message: 'Only customers can review products' });

    const rating = Math.round(Number(req.body.rating));
    const comment = String(req.body.comment || '').trim();
    if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ message: 'Please choose a rating from 1 to 5 stars' });
    if (comment.length > 500) return res.status(400).json({ message: 'Feedback is too long (max 500 characters)' });

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const order = await findDeliveredOrder(req.user._id, productId);
    if (!order) return res.status(403).json({ message: 'You can review a product after your order has been delivered' });

    const review = await Review.findOneAndUpdate(
      { product: productId, user: req.user._id },
      { rating, comment, order: order._id },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    const stats = await refreshStats(productId);
    res.status(201).json({ review, ...stats });
  } catch (err) {
    next(err);
  }
});

// Admin: delete a review / feedback (the product's rating is recalculated)
router.delete('/:id', protect, adminOnly, async (req, res, next) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ message: 'Review not found' });
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ message: 'Review not found' });
    const stats = await refreshStats(review.product);
    res.json({ message: 'Review deleted', ...stats });
  } catch (err) {
    next(err);
  }
});

export default router;
