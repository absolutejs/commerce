// The card terminal on the counter.
//
// Online checkout and counter payment look nothing alike: online, the browser
// goes to the provider and comes back; at the counter, the customer taps a
// piece of hardware that belongs to the shop and the till waits for it. This
// contract is that second shape — devices you can send an amount to, and one
// checkout you can watch, cancel, and hear about over a webhook.
//
// Money is integer cents, like everywhere else in commerce.

export type TerminalDeviceStatus = "offline" | "online" | "unknown";

export type TerminalDevice = {
  id: string;
  /** What the shop calls it — "Front counter", "Back bench". */
  name: string;
  status: TerminalDeviceStatus;
};

/** Where a counter payment is. `pending` is "sent, the device has not picked
 *  it up yet"; `in-progress` is "the customer is at the screen". */
export type TerminalCheckoutStatus =
  "canceled" | "completed" | "failed" | "in-progress" | "pending";

export type TerminalCheckout = {
  id: string;
  amountCents: number;
  currency: string;
  deviceId: string;
  status: TerminalCheckoutStatus;
  /** The provider's payment id once it completes — what a refund is issued
   *  against. Null until then. */
  paymentId: string | null;
  /** The shop's own reference for the sale, echoed back. */
  reference: string | null;
  cardBrand: string | null;
  last4: string | null;
  /** Why it failed or was canceled, in the provider's words. */
  reason: string | null;
};

export type StartTerminalCheckoutInput = {
  amountCents: number;
  currency?: string;
  deviceId: string;
  /** Stable retry identity: the same key must never charge twice. */
  idempotencyKey: string;
  /** Shown on the device while the customer pays. */
  note?: string;
  reference?: string;
};

/** What a verified terminal webhook carries: the event name and the checkout
 *  it is about, when the event is about one. */
export type TerminalWebhookEvent = {
  type: string;
  checkout: TerminalCheckout | null;
};

export type TerminalProvider = {
  /** Provider id, e.g. "square". */
  id: string;
  listDevices(): Promise<TerminalDevice[]>;
  startCheckout(input: StartTerminalCheckoutInput): Promise<TerminalCheckout>;
  getCheckout(checkoutId: string): Promise<TerminalCheckout>;
  cancelCheckout(checkoutId: string): Promise<TerminalCheckout>;
  /**
   * Verify a webhook and project it onto the contract. `url` is the endpoint
   * the provider posted to — some providers sign it along with the body.
   */
  verifyWebhook(
    payload: string,
    signature: string,
    url?: string,
  ): Promise<TerminalWebhookEvent>;
};
