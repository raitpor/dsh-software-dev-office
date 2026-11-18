/** M4-G 读数注册表（卡 C1–C6）：R1–R4 + 两条 M3 遗留；保留 M4-6/M4-7 的复用读数。 */
import { measureLegacyGateName, measureLegacyHuman } from './legacy.mjs';
import { measureHumanSamples } from './r-human.mjs';
import { rPick } from './r-pick.mjs';
import { r1 } from './r1.mjs';
import { r2 } from './r2.mjs';
import { r3 } from './r3.mjs';
import { r4 } from './r4.mjs';

export const MEASURES = {
  R1: r1,
  R2: r2,
  R3: r3,
  R4: r4,
  'R-legacy1': measureLegacyHuman,
  'R-legacy2': measureLegacyGateName,
  'R-pick': rPick,
  'R-human': measureHumanSamples,
};
