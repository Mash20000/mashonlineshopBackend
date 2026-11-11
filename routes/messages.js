import { Router } from 'express';
import mongoose from 'mongoose';
import Message from '../models/Message.js';
import { protect } from '../middleware/auth.js';

// Notifications only. Customer <-> admin chat lives in routes/chat.js.
const router = Router();

// Admin sees order / payment notifications; a customer sees delivery updates sent to them.
const inboxFilter = (user) =>
  user.role === 'admin'
    ? { toAdmin: true, type: { $in: ['order', 'payment', 'stock'] } }
    : { recipient: user._id, type: 'delivery' };

router.get('/', protect, async (req, res, next) => {
  try {
    const messages = await Message.find(inboxFilter(req.user))
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('sender', 'name username phone')
      .populate('order', 'total status paymentStatus');
    res.json(messages);
  } catch (err) {
    next(err);
  }
});

router.get('/unread-count', protect, async (req, res, next) => {
  try {
    const count = await Message.countDocuments({ ...inboxFilter(req.user), read: false });
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

router.patch('/read-all', protect, async (req, res, next) => {
  try {
    await Message.updateMany({ ...inboxFilter(req.user), read: false }, { read: true });
    res.json({ message: 'All marked as read' });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/read', protect, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Message not found' });
    const message = await Message.findOneAndUpdate({ _id: req.params.id, ...inboxFilter(req.user) }, { read: true }, { new: true });
    if (!message) return res.status(404).json({ message: 'Message not found' });
    res.json(message);
  } catch (err) {
    next(err);
  }
});

export default router;
