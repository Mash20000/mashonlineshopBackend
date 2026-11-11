import PushSubscription from '../models/PushSubscription.js';
import User from '../models/User.js';

// web-push is loaded lazily so the server still starts (without notifications) if the package is not installed yet.
let webpush = null;
try {
  webpush = (await import('web-push')).default;
} catch {
  console.warn('Push notifications are off: run "npm install" in the server folder to install web-push.');
}

let configured = false;
let warnedNotReady = false;

const ready = () => {
  if (!webpush || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  if (!configured) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    configured = true;
  }
  return true;
};

export const pushEnabled = () => ready();

const trim = (text, max) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * Send a notification to every device of the given user(s).
 * payload: { title, body, url, tag, force }. Never throws, so callers can fire and forget.
 * Returns { sent, errors: [{ statusCode, message }], mismatch } (used by the test button).
 */
export async function sendPush(userIds, payload) {
  const result = { sent: 0, errors: [], mismatch: false };
  try {
    if (!ready()) {
      if (!warnedNotReady) {
        warnedNotReady = true;
        console.warn('Push skipped: web-push is not installed or VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are missing in .env');
      }
      return result;
    }
    const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String);
    if (!ids.length) return result;

    const subs = await PushSubscription.find({ user: { $in: ids } });
    if (!subs.length) {
      console.log(`Push: no device registered for ${ids.length} user(s), nothing sent ("${payload.title}")`);
      return result;
    }

    const body = JSON.stringify({
      title: trim(payload.title || 'Mash Online Shop', 60),
      body: trim(payload.body, 140),
      url: payload.url || '/',
      tag: payload.tag || undefined,
      force: payload.force ? true : undefined, // show even when the shop is open on screen
    });

    // send in small batches so a big broadcast does not open hundreds of connections at once
    for (let i = 0; i < subs.length; i += 25) {
      await Promise.allSettled(
        subs.slice(i, i + 25).map(async (sub) => {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              body,
              { TTL: 60 * 60 * 24 }
            );
            result.sent += 1;
          } catch (err) {
            const code = err.statusCode;
            result.errors.push({ statusCode: code, message: err.body || err.message });
            if (code === 404 || code === 410) {
              // the device unsubscribed or the browser data was cleared
              await PushSubscription.deleteOne({ _id: sub._id });
            } else if (code === 401 || code === 403) {
              // subscribed with different VAPID keys than the server has now: the device must subscribe again
              result.mismatch = true;
              await PushSubscription.deleteOne({ _id: sub._id });
            }
            console.error('Push failed:', code || err.message, err.body || '');
          }
        })
      );
    }
    console.log(`Push: "${payload.title}" delivered to ${result.sent} of ${subs.length} device(s)`);
  } catch (err) {
    console.error('Push error:', err.message);
  }
  return result;
}

export async function pushToAdmins(payload) {
  try {
    const admins = await User.find({ role: 'admin' }).select('_id');
    await sendPush(admins.map((a) => a._id), payload);
  } catch (err) {
    console.error('Push error:', err.message);
  }
}
