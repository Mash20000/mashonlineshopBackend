import axios from 'axios';

const baseUrl = () =>
  process.env.DARAJA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

/** Get a short-lived OAuth token from Daraja. */
export const getAccessToken = async () => {
  const auth = Buffer.from(
    `${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`
  ).toString('base64');

  const { data } = await axios.get(`${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  return data.access_token;
};

/** Normalise 07XXXXXXXX / +2547XXXXXXXX / 7XXXXXXXX to 2547XXXXXXXX. */
export const formatPhone = (phone) => {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.length === 9) return `254${digits}`;
  return digits;
};

const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
};

/**
 * Send an STK Push prompt to the customer's phone.
 * Returns Daraja's response (contains MerchantRequestID and CheckoutRequestID).
 */
export const stkPush = async ({ phone, amount, accountReference = 'MashShop', description = 'Order payment' }) => {
  const token = await getAccessToken();
  const ts = timestamp();
  const password = Buffer.from(
    `${process.env.DARAJA_SHORTCODE}${process.env.DARAJA_PASSKEY}${ts}`
  ).toString('base64');
  const msisdn = formatPhone(phone);

  const { data } = await axios.post(
    `${baseUrl()}/mpesa/stkpush/v1/processrequest`,
    {
      BusinessShortCode: process.env.DARAJA_SHORTCODE,
      Password: password,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: msisdn,
      PartyB: process.env.DARAJA_SHORTCODE,
      PhoneNumber: msisdn,
      CallBackURL: process.env.DARAJA_CALLBACK_URL,
      AccountReference: accountReference,
      TransactionDesc: description,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return data;
};
