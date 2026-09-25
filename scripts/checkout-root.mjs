import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Reuse the installer's ancestor check without executing an untrusted Git first.
// An enclosing checkout also owns sibling tools outside a nested submodule.
export function checkoutRoot(path) {
  let checkout = realpathSync(path);
  for (let ancestor = dirname(checkout);; ancestor = dirname(ancestor)) {
    if (existsSync(join(ancestor, '.git'))) checkout = ancestor;
    if (dirname(ancestor) === ancestor) return checkout;
  }
}
