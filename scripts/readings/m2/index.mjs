/** M2-G 七条读数注册表（顺序即报告顺序）。 */
import { measureR1, measureR2, measureR3, measureR4, measureR6 } from './sign-readings.mjs';
import { measureR5 } from './timing.mjs';
import { measureR7 } from './gate.mjs';

export const MEASURES = Object.freeze({
  R1: measureR1,
  R2: measureR2,
  R3: measureR3,
  R4: measureR4,
  R5: measureR5,
  R6: measureR6,
  R7: measureR7,
});
