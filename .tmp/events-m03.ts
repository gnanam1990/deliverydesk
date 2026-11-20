import { registerEventHandler } from './inbox.ts';
import { recordReceipt } from './payments.ts';
import { applyMerchantStatus, registerArtifactFetchDispatcher } from './fulfillments.ts';

let registered = false;

/**
 * Wire connector event kinds to domain processors. Registration is global
 * (the handler table is app-level); idempotent for repeated buildApp calls
 * in tests.
 */
export function registerDomainEventHandlers(): void {
  if (registered) return;
  registered = true;
  registerEventHandler('payment.receipt', recordReceipt);
  registerEventHandler('fulfillment.status', applyMerchantStatus);
  registerArtifactFetchDispatcher();
}
