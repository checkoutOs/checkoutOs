// Razorpay Basic Auth Validation
// auth.ts
export const MOCK_RAZORPAY_KEY_ID = 'rzp_test_mockKeyId00001';
export const MOCK_RAZORPAY_KEY_SECRET = 'mockSecret00001';

const EXPECTED_CREDENTIALS = Buffer.from(
  `${MOCK_RAZORPAY_KEY_ID}:${MOCK_RAZORPAY_KEY_SECRET}`,
).toString('base64');

export type AuthResult =
  | { valid: true }
  | { valid: false; reason: 'missing_header' | 'invalid_credentials' };

// validate the authorization header of an incoming request

export function ValidateBasicAuth(request: Request): AuthResult {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Basic')) {
    return { valid: false, reason: 'missing_header' };
  }

  const encoded = authHeader.slice('Basic '.length).trim();

  if (encoded !== EXPECTED_CREDENTIALS) {
    return { valid: false, reason: 'invalid_credentials' };
  }
  return { valid: true };
}
