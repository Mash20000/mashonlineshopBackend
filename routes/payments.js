import { Router } from 'express';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import Message from '../models/Message.js';
import { pushToAdmins } from '../utils/push.js';
import { LOW_STOCK } from '../utils/pricing.js';

const router = Router();
const shortId = (id) => String(id).slice(-6).toUpperCase();

// After a sale: tell the admin (notification + device alert) about products that are now low or sold out.
async function alertLowStock(productIds) {
  try {
    const unique = [...new Set(productIds.map(String))];
    for (const product of await Product.find({ _id: { $in: unique } }).select('name stock')) {
      if (product.stock > LOW_STOCK) continue;
      const text =
        product.stock <= 0
          ? `"${product.name}" is sold out. Restock it so you do not lose sales.`
          : `"${product.name}" is running low: only ${product.stock} left.`;
      await Message.create({ toAdmin: true, type: 'stock', name: product.name, text });
      pushToAdmins({ title: product.stock <= 0 ? 'Sold out' : 'Low stock', body: text, url: '/store', tag: `stock-${product._id}` });
    }
  } catch (err) {
    console.error('Low stock alert error:', err.message);
  }
}

/**
 * Daraja calls this URL after the customer enters (or cancels) their M-Pesa PIN.
 * Set DARAJA_CALLBACK_URL to  https://<public-host>/api/payments/callback?token=<DARAJA_CALLBACK_SECRET>
 */
router.post('/callback', async (req, res) => {
  const accepted = { ResultCode: 0, ResultDesc: 'Accepted' };

  if (process.env.DARAJA_CALLBACK_SECRET && req.query.token !== process.env.DARAJA_CALLBACK_SECRET) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return res.json(accepted);

    const order = await Order.findOne({ checkoutRequestId: String(cb.CheckoutRequestID) });
    if (!order || order.paymentStatus !== 'pending') return res.json(accepted);

    if (Number(cb.ResultCode) === 0) {
      const meta = cb.CallbackMetadata?.Item || [];
      const get = (key) => meta.find((i) => i.Name === key)?.Value;

      // Only accept the payment if the amount matches what we asked for
      if (Number(get('Amount')) !== Math.round(order.total)) {
        order.paymentStatus = 'failed';
        order.status = 'cancelled';
        order.paymentNote = 'Amount paid did not match the order total';
        await order.save();
        return res.json(accepted);
      }

      // The customer pressed Cancel but still entered their PIN: the money arrived, so the admin must refund it.
      const paidAfterCancel = order.status === 'cancelled';

      order.paymentStatus = 'paid';
      order.mpesaReceipt = get('MpesaReceiptNumber');
      if (paidAfterCancel) order.paymentNote = 'Paid after the customer cancelled: refund needed';
      await order.save();

      if (!paidAfterCancel) {
        for (const item of order.items) {
          await Product.updateOne({ _id: item.product, stock: { $gte: item.qty } }, { $inc: { stock: -item.qty } });
        }
        await alertLowStock(order.items.map((i) => i.product));
      }

      pushToAdmins({
        title: paidAfterCancel ? 'Refund needed' : 'Payment received',
        body: paidAfterCancel
          ? `${order.name} paid KES ${order.total.toLocaleString('en-KE')} after cancelling order #${shortId(order._id)}`
          : `${order.name} paid KES ${order.total.toLocaleString('en-KE')} for order #${shortId(order._id)}`,
        url: '/account',
        tag: `payment-${order._id}`,
      });

      await Message.create({
        sender: order.user,
        toAdmin: true,
        type: 'payment',
        name: order.name,
        phone: order.phone,
        order: order._id,
        text: paidAfterCancel
          ? `REFUND NEEDED: ${order.name} (${order.phone}) cancelled order #${shortId(order._id)} but the M-Pesa payment of KES ${order.total.toLocaleString(
              'en-KE'
            )} still went through. M-Pesa receipt: ${order.mpesaReceipt || 'n/a'}. The order was not processed.`
          : `Payment received for order #${shortId(order._id)} (KES ${order.total.toLocaleString('en-KE')}). M-Pesa receipt: ${
              order.mpesaReceipt || 'n/a'
            }.`,
      });
    } else {
      order.paymentStatus = 'failed';
      order.status = 'cancelled';
      // keep "Cancelled by customer" if the customer cancelled first
      if (!order.paymentNote) order.paymentNote = cb.ResultDesc || 'Payment was not completed';
      await order.save();
    }
  } catch (err) {
    console.error('Callback error:', err.message);
  }

  res.json(accepted);
});

export default router;
