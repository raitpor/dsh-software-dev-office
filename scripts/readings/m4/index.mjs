/** M4 读数注册表（卡 C6/E2）：R-pick（M4-7）+ R-human（M4-6）。 */
import { measureHumanSamples } from './r-human.mjs';
import { rPick } from './r-pick.mjs';

export const MEASURES = { 'R-pick': rPick, 'R-human': measureHumanSamples };
