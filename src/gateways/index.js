// Gateway registry (chunk F4). One adapter builder per gateway name. Unknown gateway: refused, never a default.
import { ApiError } from '../util.js';
import { razorpayGateway } from './razorpay.js';

export const ADAPTERS = { razorpay: razorpayGateway };

/** Adapter for a payee record. Secrets come from the injected reader; HTTP from the injected fetch. */
export function gatewayFor(payee, { reader, fetch, adapters = ADAPTERS }) {
  const make = adapters[payee?.gateway];
  if (!make) throw new ApiError(422, 'gateway_unsupported', 'No adapter exists for this payment gateway.');
  return make({ payee, reader, fetch });
}
