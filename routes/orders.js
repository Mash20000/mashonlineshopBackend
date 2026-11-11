import { Router } from 'express';
import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import Message from '../models/Message.js';
import { protect, adminOnly } from '../middleware/auth.js';
import { stkPush, formatPhone } from '../utils/daraja.js';
import { effectivePrice, optionsText } from '../utils/pricing.js';
import { sendPush, pushToAdmins } from '../utils/push.js';

const router = Router();
const shortId = (id) => String(id).slice(-6).toUpperCase();

// Customer: place an order and send the STK push to their phone
router.post('/', protect, async (req, res, next) => {
  try {
    if (req.user.role === 'admin') {
      return res.status(403).json({ message: 'Admin accounts cannot place orders. Please use a customer account.' });
    }

    const name = String(req.body.name || '').trim();
    const phone = formatPhone(req.body.phone || '');
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];

    if (!name) return res.status(400).json({ message: 'Please enter your name' });
    if (!/^254[17]\d{8}$/.test(phone)) {
      return res.status(400).json({ message: 'Enter a valid Safaricom number e.g. 0712345678' });
    }
    if (!rawItems.length) return res.status(400).json({ message: 'Your cart is empty' });
    if (rawItems.length > 50) return res.status(400).json({ message: 'Too many items in the cart' });

    const lines = [];
    for (const item of rawItems) {
      const id = String(item.productId);
      const qty = Math.floor(Number(item.qty));
      if (!mongoose.isValidObjectId(id) || !(qty > 0)) {
        return res.status(400).json({ message: 'Invalid item in cart' });
      }
      const picked = item.options && typeof item.options === 'object' && !Array.isArray(item.options) ? item.options : {};
      lines.push({ id, qty, picked });
    }

    // Prices always come from the database, never from the browser
    const ids = [...new Set(lines.map((l) => l.id))];
    const products = await Product.find({ _id: { $in: ids } }).select('+costPrice');
    if (products.length !== ids.length) {
      return res.status(400).json({ message: 'A product in your cart is no longer available' });
    }
    const byId = new Map(products.map((p) => [p._id.toString(), p]));

    const items = [];
    const qtyPerProduct = new Map();
    let total = 0;

    for (const line of lines) {
      const p = byId.get(line.id);

      // Every option group (size, colour, RAM...) must have a valid choice
      const chosen = [];
      for (const group of p.optionGroups) {
        const value = String(line.picked[group.name] ?? '');
        if (!group.values.includes(value)) {
          return res.status(400).json({ message: `Please choose ${group.name} for "${p.name}"` });
        }
        chosen.push({ name: group.name, value });
      }

      const price = effectivePrice(p);
      items.push({ product: p._id, name: p.name, price, qty: line.qty, image: p.image, chosen, cost: p.costPrice ?? undefined });
      total += price * line.qty;
      qtyPerProduct.set(line.id, (qtyPerProduct.get(line.id) || 0) + line.qty);
    }

    for (const [id, qty] of qtyPerProduct) {
      const p = byId.get(id);
      if (qty > p.stock) {
        return res.status(400).json({ message: p.stock > 0 ? `Only ${p.stock} of "${p.name}" left in stock` : `"${p.name}" is out of stock` });
      }
    }

    const order = await Order.create({ user: req.user._id, items, total, name, phone });

    try {
      const result = await stkPush({
        phone,
        amount: total,
        accountReference: `MASH${shortId(order._id)}`,
        description: 'Mash Shop',
      });
      if (String(result.ResponseCode) !== '0') throw new Error(result.ResponseDescription || 'STK push rejected');
      order.checkoutRequestId = result.CheckoutRequestID;
      order.merchantRequestId = result.MerchantRequestID;
      await order.save();
    } catch (err) {
      console.error('STK push failed:', err.response?.data || err.message);
      order.status = 'cancelled';
      order.paymentStatus = 'failed';
      order.paymentNote = 'Could not send STK push';
      await order.save();
      return res.status(502).json({ message: 'Could not send the M-Pesa prompt. Check your number and try again.' });
    }

    await Message.create({
      sender: req.user._id,
      toAdmin: true,
      type: 'order',
      name,
      phone,
      order: order._id,
      text: `New order #${shortId(order._id)} from ${name} (${phone}): ${items
        .map((i) => `${i.qty} x ${i.name}${optionsText(i.chosen)}`)
        .join(', ')}. Total KES ${total.toLocaleString('en-KE')}. Awaiting M-Pesa payment.`,
    });

    pushToAdmins({
      title: 'New order',
      body: `${name} ordered ${items.length} item${items.length === 1 ? '' : 's'} (KES ${total.toLocaleString('en-KE')})`,
      url: '/account',
      tag: `order-${order._id}`,
    });

    res.status(201).json(order);
  } catch (err) {
    next(err);
  }
});

// Customer: own orders
router.get('/mine', protect, async (req, res, next) => {
  try {
    const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

// Admin: all orders (?status=pending|delivered|cancelled|all). Defaults to pending.
router.get('/', protect, adminOnly, async (req, res, next) => {
  try {
    const status = String(req.query.status || 'pending');
    const filter = status === 'all' ? {} : { status };
    const orders = await Order.find(filter).sort({ createdAt: -1 }).populate('user', 'name username phone');
    res.json(orders);
  } catch (err) {
    next(err);
  }
});

// Used by the checkout screen to poll the payment result
router.get('/:id', protect, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found' });
    const order = await Order.findById(req.params.id);
    const isOwner = order && order.user.toString() === req.user._id.toString();
    if (!order || (!isOwner && req.user.role !== 'admin')) return res.status(404).json({ message: 'Order not found' });
    res.json(order);
  } catch (err) {
    next(err);
  }
});

// Customer: cancel an order while its payment is still waiting.
// An STK push cannot be recalled once sent, so if the customer still pays, payments.js flags it for a refund.
router.patch('/:id/cancel', protect, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found' });
    const order = await Order.findOne({ _id: req.params.id, user: req.user._id });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.paymentStatus === 'paid') {
      return res.status(409).json({ message: 'Your payment was already received, so this order can no longer be cancelled here.' });
    }
    if (order.status === 'cancelled') return res.json(order); // already cancelled
    if (order.status !== 'pending') return res.status(400).json({ message: 'This order cannot be cancelled' });

    order.status = 'cancelled';
    order.paymentNote = 'Cancelled by customer';
    await order.save();

    await Message.create({
      sender: req.user._id,
      toAdmin: true,
      type: 'order',
      name: order.name,
      phone: order.phone,
      order: order._id,
      text: `Order #${shortId(order._id)} from ${order.name} (${order.phone}) was cancelled by the customer before payment.`,
    });

    res.json(order);
  } catch (err) {
    next(err);
  }
});

// Admin: mark as delivered and notify the customer
router.patch('/:id/deliver', protect, adminOnly, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found' });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.status !== 'pending') return res.status(400).json({ message: 'This order is not pending' });

    order.status = 'delivered';
    order.deliveredAt = new Date();
    await order.save();

    const note = String(req.body.note || '').trim().slice(0, 500);
    sendPush([order.user], {
      title: 'Your order was delivered',
      body: note || `Order #${shortId(order._id)} has been delivered. You can now rate your products.`,
      url: '/account',
      tag: `delivery-${order._id}`,
    });
    await Message.create({
      sender: req.user._id,
      recipient: order.user,
      type: 'delivery',
      order: order._id,
      text:
        note ||
        `Your order #${shortId(order._id)} has been delivered. You can now rate your products in your Account page. Thank you for shopping with Mash Online Shop!`,
    });

    res.json(order);
  } catch (err) {
    next(err);
  }
});

export default router;
