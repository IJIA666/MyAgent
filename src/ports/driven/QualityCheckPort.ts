/**
 * @file QualityCheckPort.ts
 * @description 定义后置质量校验驱动端口契约。
 */

export interface QualityCheckPort {
  /**
   * 执行后置质量自测校验，对项目运行代码规范与类型检查。
   *
   * @returns 异步返回校验结果对象，包含是否成功以及控制台报错文本
   */
  runPostRunCheck(): Promise<{ success: boolean; output: string }>;
}
