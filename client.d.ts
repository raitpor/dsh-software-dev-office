/**
 * SDO 客户端半的**导航参数契约**（类型声明，随包交付；运行时不读它）。
 *
 * 为什么要有它（2026-10-09 测试报告 OBS-001）：`client.js` 通过
 * `ctx.sidebarRight.openResource(address, { params })` 把审核单正文递给右侧边栏，
 * 而宿主把 `params` 定义成**声明合并映射** `SidebarRightResourceParamsMap`
 * （`@deepseek-ai/dsh-client-ui-sidebar-right/client` 的 `contract/params.d.ts`，默认空接口，
 * 由各资源类型自己 `declare module` 补片）。宿主的自带包都做了这件事
 * （`dsh-client-ui-plan` 声明 `'plan-review'`），SDO 之前**没有** —— 这段参数
 * 「靠约定写、从未被类型校验」。
 *
 * 这里补上那一片：`dsh-resource://sdo-review/**` 上携带 `{ sdoReview: { markdown, title } }`。
 * 写成**脚本式**（无顶层 import/export）的 ambient 声明：在装有该包的工程里它是**声明合并**，
 * 在没有该包的工程里它只是声明，不会因 "module cannot be found" 报错。
 */
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /** 门禁签字审核单：正文（整份 Markdown）与标签页标题（取正文首行）。 */
    'sdo-review': {
      sdoReview: {
        markdown: string
        title: string
      }
    }
  }
}
