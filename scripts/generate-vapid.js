// Run once:  npm run vapid
// Prints the two keys that let your server send notifications. Paste them into server/.env
import crypto from 'crypto';

const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();

const priv = ecdh.getPrivateKey();
const privateKey = Buffer.concat([Buffer.alloc(32 - priv.length), priv]); // always 32 bytes

console.log('Add these two lines to server/.env (keep the private key secret):\n');
console.log(`VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey.toString('base64url')}`);
