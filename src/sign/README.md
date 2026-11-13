# src/sign/ · 签字与安全

职责：登录、签章口令（unlock）、`signerd`、免密窗口、签名字段。

- 写域：`security` 泳道（impl-security，**M2 起进场**）。M0 不碰密钥，本目录先留职责说明。
- 第一张填充卡：M2。
- 纪律：agent 任何路径都不能产生 `decision` 行；测试只能用标 `fixture` 的假 signer（plan/01 §2）。
