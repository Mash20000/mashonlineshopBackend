import mongoose from 'mongoose';

// One row per device (browser) that agreed to receive notifications.
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
    userAgent: String,
  },
  { timestamps: true }
);

export default mongoose.model('PushSubscription', pushSubscriptionSchema);
