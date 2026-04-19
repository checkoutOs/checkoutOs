// checkoutOs Mock gateway server

// * Starts a standalone HTTP server that intercepts requests
// * to real payment gateway endpoints and returns predictable
// * mock responses.

// Usage:
//  *   npm run mock:gateway
// The server listens on the port defined by MOCK_PORT (default: 9090).

//  * Adding a new gateway:
//  *   1. Create mocks/gateways/<gateway>/handlers.ts
// *   2. Import and spread into allHandlers below
// *   3. Done — no other changes needed

import { createServer } from '@mswjs/http-middleware';

import { razorpayHandlers } from './gateways/razorpay/handlers.js';

const allHandlers = [...razorpayHandlers];

const PORT = Number(process.env.MOCK_PORT) || 9090;
const server = createServer(...allHandlers);

server.listen(PORT, () => {
  console.log('  ✓ checkoutOs Mock Gateway Server');
  console.log(`  ✓ Listening on http://localhost:${PORT}`);
  console.log('');
  console.log('  Active mocks:');
  console.log('    [razorpay]  POST https://api.razorpay.com/v1/orders');
  console.log('    [razorpay]  POST http://localhost:9090/v1/orders');

  console.log('');
  console.log('  Test credentials:');
  console.log('    RAZORPAY_KEY_ID     = rzp_test_mockKeyId00001');
  console.log('    RAZORPAY_KEY_SECRET = mockSecret00001');
  console.log('');
});
