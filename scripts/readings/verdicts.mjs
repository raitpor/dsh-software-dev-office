/**
 * 读数 verdict → 进程退出码的纯函数（可单测，不依赖临时库/子进程）。
 * 任一条 fail ⇒ 1；partial 不算 fail ⇒ 0；全 pass ⇒ 0。
 */

export function overallFor(verdicts) {
  const values = Object.values(verdicts);
  if (values.includes('fail')) return 'fail';
  if (values.includes('partial')) return 'partial';
  return 'pass';
}

export function exitCodeFor(verdicts) {
  return overallFor(verdicts) === 'fail' ? 1 : 0;
}
