import mongoose from 'mongoose';

/**
 * Notifications (chat now lives in ChatMessage):
 *  - order    : system -> admin     (someone placed an order)
 *  - payment  : system -> admin     (payment confirmed)
 *  - stock    : system -> admin     (a product is running low or sold out)
 *  - delivery : admin  -> customer  (order delivered)
 * 'message' and 'reply' are legacy values from the old Profile form and are kept so old data still loads.
 */
const messageSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    toAdmin: { type: Boolean, default: false },
    type: { type: String, enum: ['order', 'payment', 'stock', 'delivery', 'message', 'reply'], required: true },
    name: String,
    phone: String,
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model('Message', messageSchema);
