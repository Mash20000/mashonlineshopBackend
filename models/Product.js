import mongoose from 'mongoose';
import { effectivePrice } from '../utils/pricing.js';

// e.g. { name: 'Size', values: ['S', 'M', 'L'] } or { name: 'RAM', values: ['8GB', '16GB'] }
const optionGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    values: { type: [String], default: [] },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    category: { type: String, required: true, trim: true },
    stock: { type: Number, default: 1, min: 0 },
    // Cloudinary link (saved in MongoDB instead of the image itself)
    image: { type: String, required: true },
    imagePublicId: { type: String },

    // Offers
    onOffer: { type: Boolean, default: false },
    offerPrice: { type: Number, min: 0, default: null },

    // What the shop paid for one item. Never sent to customers (select: false); used for profit in the Store page.
    costPrice: { type: Number, min: 0, default: null, select: false },

    // Choices the customer must pick (size, colour, RAM...)
    optionGroups: { type: [optionGroupSchema], default: [] },

    // Filled in from customer reviews
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true, id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

productSchema.virtual('currentPrice').get(function () {
  return effectivePrice(this);
});

export default mongoose.model('Product', productSchema);
