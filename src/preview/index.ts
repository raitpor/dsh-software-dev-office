/** M1-5 preview 的公开入口：一次变更的 `will_change` + `rework_units`。 */
export {
  collectInvalidatedWorkUnits,
  diffPreviewStates,
  previewChange,
} from './rework.js';
export { PreviewError } from './types.js';
export type {
  PreviewChange,
  PreviewChangeKind,
  PreviewOptions,
  PreviewReason,
  PreviewResult,
  ReworkUnitEvidence,
} from './types.js';
