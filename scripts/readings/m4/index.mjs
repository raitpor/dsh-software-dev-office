/** M4-7 读数注册表（卡 C6/E2）。只登记 R-pick：M4-G 再统一扩。 */
import { rPick } from './r-pick.mjs';

export const MEASURES = { 'R-pick': rPick };
