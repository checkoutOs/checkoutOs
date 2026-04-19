// src/views/checkout.view.ts

import { CheckoutViewData } from './types';

export function renderCheckoutPage(data: CheckoutViewData): string {
  if (data.gateway === 'razorpay') {
    return renderRazorpayCheckout(data);
  }

  throw new Error(`Unsupported gateway: ${data.gateway}`);
}

function renderRazorpayCheckout(data: CheckoutViewData): string {
  return `
  <!DOCTYPE html>
  <html>
    <head>
      <title>Checkout</title>
      <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    </head>
  
    <body>
      <h3>Redirecting to payment...</h3>
  
      <script>
        const options = {
          key: "${process.env.RAZORPAY_KEY_ID}",
          amount: ${data.amount},
          currency: "${data.currency}",
          order_id: "${data.gatewayOrderId}",
  
          handler: function (response) {
            window.location.href = "/checkout/${data.chkId}";
          },
  
          modal: {
            ondismiss: function () {
              window.location.href = "/checkout/${data.chkId}";
            }
          }
        };
  
        const rzp = new Razorpay(options);
        rzp.open();
      </script>
    </body>
  </html>
  `;
}

export function renderSuccessPage(data: CheckoutViewData): string {
  return `
    <html>
      <body>
        <h1>✅ Payment Successful</h1>
        <p>Payment ID: ${data.chkId}</p>
        <p>Amount: ${data.amount / 100} INR</p>
      </body>
    </html>
  `;
}

export function renderFailurePage(data: CheckoutViewData): string {
  return `
    <html>
      <body>
        <h1>❌ Payment Failed</h1>
        <p>Payment ID: ${data.chkId}</p>
        <p>Please try again</p>
      </body>
    </html>
  `;
}

export function renderProcessingPage(data: CheckoutViewData): string {
  return `
      <html>
        <body>
          <h2>⏳ Processing your payment...</h2>
          <p>Please wait, do not refresh</p>
  
          <script>
            async function poll() {
              const res = await fetch("/payments/${data.chkId}");
              const json = await res.json();
  
              if (json.data.status === "SUCCESS") {
                window.location.reload();
              }
  
              if (json.data.status === "FAILED") {
                window.location.reload();
              }
            }
  
            setInterval(poll, 2000); // poll every 2 sec
          </script>
        </body>
      </html>
    `;
}
