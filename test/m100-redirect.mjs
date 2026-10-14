/** 注册 {@link ./m100-hooks.mjs}（TASK-072 / REV-038 核实用的只读变异复跑入口）。 */
import { register } from 'node:module'
register('./m100-hooks.mjs', import.meta.url)
