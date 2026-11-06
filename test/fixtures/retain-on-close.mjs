// Child-process-only fault: reject one normal close while retaining the browser.
import { HeadlessAdapter } from '../../dist/headless-adapter.js';
import { GatewayError } from '../../dist/errors.js';
const close = HeadlessAdapter.prototype.close;
let armed = true;
HeadlessAdapter.prototype.close = function(force = false) {
  if (!force && this.hasResources && armed) {
    armed = false;
    return Promise.reject(new GatewayError('SAVE_UNCONFIRMED', 'Injected live-editor close failure', true));
  }
  return close.call(this, force);
};
