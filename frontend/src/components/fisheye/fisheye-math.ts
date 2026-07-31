/**
 * 鱼眼导航核心数学（纯函数，无 DOM 依赖，独立可测）。
 *
 * 数学模型：正态分布（高斯）映射 —— 输入圆点中心与鼠标的距离，
 * 输出该圆点应展现的宽度。
 *   factor = exp(-0.5 * (d / (range / 2.5))²)   —— 中心 1，两侧渐弱
 *   width  = minW + (maxW - minW) * factor
 *
 * 性能要点（对应"四层优化"中的算法层）：
 *   - 切尾：distance > range 直接返回 minW，不做任何幂运算（快速剔除）。
 *   - 纯函数：调用方（Ref+rAF 直写 DOM）可在 rAF 帧内批量复用。
 */

export interface FisheyeOptions {
  /** 最大展开宽度（px），鼠标正对圆点中心时达到 */
  maxW?: number
  /** 最小宽度（px），常态圆点尺寸 */
  minW?: number
  /** 影响半径（px），超过即切尾；约等于 5-9 行的高度总和 */
  range?: number
}

const DEFAULTS = { maxW: 200, minW: 10, range: 120 }

/** 由距离计算高斯系数（0-1）；越界直接 0，跳过幂运算 */
export function gaussianFactor(distance: number, range: number): number {
  if (distance >= range) return 0
  return Math.exp(-0.5 * Math.pow(distance / (range / 2.5), 2))
}

/**
 * 计算单个圆点在给定鼠标 Y 坐标下的展开宽度。
 * @param dotY   圆点中心 Y 坐标（视口坐标系）
 * @param mouseY 鼠标 Y 坐标；null 表示鼠标不在区域（常态圆点）
 */
export function calcFisheyeWidth(
  dotY: number,
  mouseY: number | null,
  opts: FisheyeOptions = {},
): number {
  const { maxW = DEFAULTS.maxW, minW = DEFAULTS.minW, range = DEFAULTS.range } = opts
  if (mouseY === null) return minW
  const distance = Math.abs(dotY - mouseY)
  if (distance >= range) return minW
  const factor = gaussianFactor(distance, range)
  return minW + (maxW - minW) * factor
}
