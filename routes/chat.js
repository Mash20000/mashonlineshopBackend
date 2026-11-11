import { Router } from 'express';
import mongoose from 'mongoose';
import ChatMessage from '../models/ChatMessage.js';
import User from '../models/User.js';
import { protect, adminOnly } from '../middleware/auth.js';
import { sendPush, pushToAdmins } from '../utils/push.js';

const router = Router();
router.use(protect);

const customerOnly = (req, res, next) =>
  req.user.role === 'admin' ? res.status(403).json({ message: 'Customers only' }) : next();

const sideOf = (user) => (user.role === 'admin' ? 'admin' : 'customer');

// What the browser gets: deleted-for-everyone messages lose their text
const clean = (m) => ({
  _id: m._id,
  from: m.from,
  text: m.deletedForAll ? '' : m.text,
  deleted: !!m.deletedForAll,
  broadcast: !!m.broadcast,
  createdAt: m.createdAt,
});

const readText = (body) => String(body.text || '').trim();
const textError = (text) => {
  if (!text) return 'Please type a message';
  if (text.length > 1000) return 'Message is too long (max 1000 characters)';
  return null;
};

const latest = async (filter) => (await ChatMessage.find(filter).sort({ createdAt: -1 }).limit(300)).reverse();

/* ---------- unread count (both roles) ---------- */
router.get('/unread-count', async (req, res, next) => {
  try {
    const filter =
      req.user.role === 'admin'
        ? { from: 'customer', readByAdmin: false, deletedForAll: { $ne: true }, hiddenFor: { $ne: 'admin' } }
        : { customer: req.user._id, from: 'admin', readByCustomer: false, deletedForAll: { $ne: true }, hiddenFor: { $ne: 'customer' } };
    res.json({ count: await ChatMessage.countDocuments(filter) });
  } catch (err) {
    next(err);
  }
});

/* ---------- admin: list of conversations, newest first ---------- */
router.get('/conversations', adminOnly, async (req, res, next) => {
  try {
    const rows = await ChatMessage.aggregate([
      // Broadcasts are left out here so one announcement does not push every customer to the top of the list.
      // They still show inside a customer's chat.
      { $match: { hiddenFor: { $ne: 'admin' }, broadcast: { $ne: true } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$customer',
          last: { $first: '$$ROOT' },
          unread: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$from', 'customer'] }, { $eq: ['$readByAdmin', false] }, { $ne: ['$deletedForAll', true] }] },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { 'last.createdAt': -1 } },
    ]);

    const users = await User.find({ _id: { $in: rows.map((r) => r._id) } }).select('name username phone');
    const byId = new Map(users.map((u) => [u._id.toString(), u]));

    res.json(
      rows
        .filter((r) => byId.has(r._id.toString()))
        .map((r) => ({ customer: byId.get(r._id.toString()), last: clean(r.last), unread: r.unread }))
    );
  } catch (err) {
    next(err);
  }
});

/* ---------- admin: bulk messages (ads, holiday greetings, shop closed notices) ---------- */
// All customers, to choose recipients from
router.get('/customers', adminOnly, async (req, res, next) => {
  try {
    const customers = await User.find({ role: 'user' }).select('name username phone').sort({ name: 1 });
    res.json(customers);
  } catch (err) {
    next(err);
  }
});

// POST /api/chat/broadcast   { text, all: true }  or  { text, customerIds: [...] }
router.post('/broadcast', adminOnly, async (req, res, next) => {
  try {
    const text = readText(req.body);
    const problem = textError(text);
    if (problem) return res.status(400).json({ message: problem });

    const filter = { role: 'user' };
    if (req.body.all !== true) {
      const ids = (Array.isArray(req.body.customerIds) ? req.body.customerIds : [])
        .map(String)
        .filter((id) => mongoose.isValidObjectId(id))
        .slice(0, 5000);
      if (!ids.length) return res.status(400).json({ message: 'Choose at least one customer' });
      filter._id = { $in: ids };
    }

    const customers = await User.find(filter).select('_id');
    if (!customers.length) return res.status(400).json({ message: 'There are no customers to send to yet' });

    // The announcement lands in each customer's chat, so it shows up in their Messages page and unread badge
    await ChatMessage.insertMany(
      customers.map((c) => ({
        customer: c._id,
        from: 'admin',
        text,
        broadcast: true,
        readByAdmin: true,
        readByCustomer: false,
      }))
    );

    // and as a notification on their devices (not awaited: the admin should not wait for it)
    sendPush(customers.map((c) => c._id), { title: 'Mash Online Shop', body: text, url: '/messages', tag: 'broadcast' });

    res.status(201).json({ sent: customers.length });
  } catch (err) {
    next(err);
  }
});

/* ---------- admin: one customer's chat ---------- */
router.get('/with/:customerId', adminOnly, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.customerId)) return res.status(404).json({ message: 'Customer not found' });
    const filter = { customer: req.params.customerId, hiddenFor: { $ne: 'admin' } };
    const messages = await latest(filter);
    await ChatMessage.updateMany({ ...filter, from: 'customer', readByAdmin: false }, { readByAdmin: true });
    res.json(messages.map(clean));
  } catch (err) {
    next(err);
  }
});

router.post('/with/:customerId', adminOnly, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.customerId)) return res.status(404).json({ message: 'Customer not found' });
    if (!(await User.exists({ _id: req.params.customerId, role: 'user' }))) return res.status(404).json({ message: 'Customer not found' });

    const text = readText(req.body);
    const problem = textError(text);
    if (problem) return res.status(400).json({ message: problem });

    const message = await ChatMessage.create({
      customer: req.params.customerId,
      from: 'admin',
      text,
      readByAdmin: true,
      readByCustomer: false,
    });

    sendPush([req.params.customerId], { title: 'Mash Online Shop', body: text, url: '/messages', tag: 'chat' });
    res.status(201).json(clean(message));
  } catch (err) {
    next(err);
  }
});

// Clear the whole chat (only for the admin's side)
router.delete('/with/:customerId', adminOnly, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.customerId)) return res.status(404).json({ message: 'Customer not found' });
    await ChatMessage.updateMany({ customer: req.params.customerId }, { $addToSet: { hiddenFor: 'admin' } });
    res.json({ message: 'Chat cleared' });
  } catch (err) {
    next(err);
  }
});

/* ---------- customer: own chat with the shop ---------- */
router.get('/', customerOnly, async (req, res, next) => {
  try {
    const filter = { customer: req.user._id, hiddenFor: { $ne: 'customer' } };
    const messages = await latest(filter);
    await ChatMessage.updateMany({ ...filter, from: 'admin', readByCustomer: false }, { readByCustomer: true });
    res.json(messages.map(clean));
  } catch (err) {
    next(err);
  }
});

router.post('/', customerOnly, async (req, res, next) => {
  try {
    const text = readText(req.body);
    const problem = textError(text);
    if (problem) return res.status(400).json({ message: problem });

    const message = await ChatMessage.create({
      customer: req.user._id,
      from: 'customer',
      text,
      readByCustomer: true,
      readByAdmin: false,
    });

    pushToAdmins({ title: req.user.name, body: text, url: '/messages', tag: `chat-${req.user._id}` });
    res.status(201).json(clean(message));
  } catch (err) {
    next(err);
  }
});

// Clear the whole chat (only for the customer's side)
router.delete('/', customerOnly, async (req, res, next) => {
  try {
    await ChatMessage.updateMany({ customer: req.user._id }, { $addToSet: { hiddenFor: 'customer' } });
    res.json({ message: 'Chat cleared' });
  } catch (err) {
    next(err);
  }
});

/* ---------- delete one message (both roles) ---------- */
// DELETE /api/chat/message/:id?scope=me|everyone
router.delete('/message/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Message not found' });
    const side = sideOf(req.user);

    const filter = { _id: req.params.id };
    if (side === 'customer') filter.customer = req.user._id;
    const message = await ChatMessage.findOne(filter);
    if (!message) return res.status(404).json({ message: 'Message not found' });

    if (req.query.scope === 'everyone') {
      if (message.from !== side) return res.status(403).json({ message: 'You can only delete your own messages for everyone' });
      message.deletedForAll = true;
    } else if (!message.hiddenFor.includes(side)) {
      message.hiddenFor.push(side);
    }
    await message.save();
    res.json({ message: 'Message deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
