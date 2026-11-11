import { Router } from 'express';
import PushSubscription from '../models/PushSubscription.js';
import { protect } from '../middleware/auth.js';
import { pushEnabled, sendPush } from '../utils/push.js';

const router = Router();

// The browser needs this public key to subscribe. key is null while push is not set up on the server.
router.get('/public-key', (req, res) => {
  res.json({ key: pushEnabled() ? process.env.VAPID_PUBLIC_KEY : null });
});

// Save this device for the logged-in user (a device that was used by someone else is reassigned)
router.post('/subscribe', protect, async (req, res, next) => {
  try {
    const sub = req.body.subscription || {};
    const endpoint = String(sub.endpoint || '');
    const p256dh = String(sub.keys?.p256dh || '');
    const auth = String(sub.keys?.auth || '');
    if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) {
      return res.status(400).json({ message: 'Invalid notification subscription' });
    }

    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { user: req.user._id, endpoint, p256dh, auth, userAgent: String(req.headers['user-agent'] || '').slice(0, 200) },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`Push: device registered for ${req.user.username}`);
    res.status(201).json({ message: 'Notifications turned on for this device' });
  } catch (err) {
    next(err);
  }
});

// Send a test notification to the logged-in person's own devices (Account page)
router.post('/test', protect, async (req, res, next) => {
  try {
    if (!pushEnabled()) {
      return res.status(503).json({
        message: 'Notifications are not set up on the server yet (the VAPID keys are missing or web-push is not installed).',
      });
    }
    const devices = await PushSubscription.countDocuments({ user: req.user._id });
    if (!devices) {
      return res.status(409).json({ message: 'No device is registered for your account yet. Turn on notifications first.', noDevice: true });
    }

    const result = await sendPush([req.user._id], {
      title: 'Test notification',
      body: 'It works! You will get messages, offers and updates like this.',
      url: '/account',
      tag: 'test',
      force: true,
    });

    if (!result.sent) {
      const code = result.errors[0]?.statusCode;
      return res.status(502).json({
        message: result.mismatch
          ? 'This device was registered with older notification keys. Registering it again...'
          : `The browser's push service rejected the notification${code ? ` (error ${code})` : ''}. Try turning notifications off and on again.`,
        mismatch: result.mismatch,
      });
    }
    res.json({ devices: result.sent });
  } catch (err) {
    next(err);
  }
});

// Stop notifications on this device (called on log out)
router.post('/unsubscribe', protect, async (req, res, next) => {
  try {
    const endpoint = String(req.body.endpoint || '');
    if (endpoint) await PushSubscription.deleteOne({ endpoint, user: req.user._id });
    res.json({ message: 'Notifications turned off for this device' });
  } catch (err) {
    next(err);
  }
});

export default router;
