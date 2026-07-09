// src/gateways/paytm/paytmchecksum.d.ts
// Type declarations for the paytmchecksum npm package.
// This package does not ship its own types, so we declare the module here.

declare module 'paytmchecksum' {
  /**
   * Generate checksum signature for a Paytm API request.
   * @param params - The request body as a plain object
   * @param key - The merchant key
   * @returns The checksum signature string
   */
  export function generateSignature(params: Record<string, unknown>, key: string): string;

  /**
   * Verify a Paytm webhook checksum.
   * @param params - The webhook body without CHECKSUMHASH (object or string)
   * @param key - The merchant/webhook secret key
   * @param checksum - The CHECKSUMHASH value to verify
   * @returns true if the checksum is valid, false otherwise
   */
  export function verifySignature(
    params: Record<string, unknown> | string,
    key: string,
    checksum: string,
  ): boolean;

  /**
   * Generate a refund checksum.
   * @param params - The refund request body
   * @param key - The merchant key
   * @returns The checksum signature string
   */
  export function generateRefundChecksum(params: Record<string, unknown>, key: string): string;
}
