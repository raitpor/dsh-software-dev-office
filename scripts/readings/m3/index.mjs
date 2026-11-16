import { measureLegacyR5 } from './legacy.mjs';
import { measureR1 } from './r1.mjs';
import { measureR2 } from './r2.mjs';
import { measureR3 } from './r3.mjs';

/** M3-G：三条判死读数 + M2 遗留 R5。 */
export const MEASURES = {
  R1: measureR1,
  R2: measureR2,
  R3: measureR3,
  R4: measureLegacyR5,
};
