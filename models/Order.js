import mongoose from 'mongoose';

const orderSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        name: String,
        price: Number, // price actually charged (offer price if the product was on offer)
        qty: Number,
        cost: Number, // buying price at the time of the order (admin analytics only, hidden from API responses)
        image: String,
        // choices made by the customer, e.g. [{ name: 'Size', value: 'M' }]
        chosen: [{ _id: false, name: String, value: String }],
      },
    ],
    total: { type: Number, required: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    // pending = waiting to be delivered
    status: { type: String, enum: ['pending', 'delivered', 'cancelled'], default: 'pending' },
    paymentStatus: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending' },
    checkoutRequestId: { type: String, index: true },
    merchantRequestId: String,
    mpesaReceipt: String,
    paymentNote: String,
    deliveredAt: Date,
  },
  {
    timestamps: true,
    toJSON: {
      transform(doc, ret) {
        if (Array.isArray(ret.items)) ret.items.forEach((i) => delete i.cost);
        return ret;
      },
    },
  }
);

export default mongoose.model('Order', orderSchema);
