import mongoose from 'mongoose';

/**
 * One conversation per customer (customer <-> admin).
 * hiddenFor: who deleted the message "for me" ('customer' and/or 'admin').
 * deletedForAll: the sender removed it for everyone.
 */
const chatMessageSchema = new mongoose.Schema(
  {
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    from: { type: String, enum: ['customer', 'admin'], required: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    readByAdmin: { type: Boolean, default: false },
    readByCustomer: { type: Boolean, default: false },
    hiddenFor: { type: [String], default: [] },
    // true when the admin sent the same announcement to many customers at once
    broadcast: { type: Boolean, default: false },
    deletedForAll: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export default mongoose.model('ChatMessage', chatMessageSchema);
