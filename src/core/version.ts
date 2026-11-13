/**
 * SDO v2 内核版本标识。
 *
 * M0-0 引入它只为证明「构建 → 测试」链路可跑；它不是对外 API 稳定性承诺。
 * 真正的版本与迁移信息由 M0-1 的 `schema_version` 承载。
 */
export const SDO_CORE_VERSION = '0.0.0-m0';

export function describeCoreVersion(): string {
  return `sdo-core/${SDO_CORE_VERSION}`;
}
