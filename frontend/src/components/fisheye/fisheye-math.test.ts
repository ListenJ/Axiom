/**
 * 鱼眼导航核心数学函数测试（纯函数，无 DOM）
 *
 * 覆盖：常态圆点、切尾边界、中心最大、对称性、单调递减、参数默认值。
 * 行为即规格：`calcFisheyeWidth` 把"圆点中心与鼠标的距离"映射为圆点宽度。
 */
import { describe, expect, it } from 'vitest'
import { calcFisheyeWidth } from './fisheye-math'

const MAX_W = 200
const MIN_W = 10
const RANGE = 120

describe('calcFisheyeWidth', () => {
  it('鼠标不在区域内时返回最小宽度（常态圆点）', () => {
    expect(calcFisheyeWidth(100, null)).toBe(MIN_W)
  })

  it('距离为 0（鼠标正对圆点中心）时返回最大宽度', () => {
    expect(calcFisheyeWidth(100, 100)).toBe(MAX_W)
  })

  it('超出影响半径直接切尾返回最小宽度（不参与高斯计算）', () => {
    expect(calcFisheyeWidth(100, 100 + RANGE + 1)).toBe(MIN_W)
    expect(calcFisheyeWidth(100, 100 - RANGE - 1)).toBe(MIN_W)
    // 恰好等于半径边界（>= 判断切尾）也应返回最小宽度
    expect(calcFisheyeWidth(100, 100 + RANGE)).toBe(MIN_W)
  })

  it('在影响范围内宽度随距离增大而单调递减', () => {
    const near = calcFisheyeWidth(100, 100 + 30)
    const mid = calcFisheyeWidth(100, 100 + 60)
    const far = calcFisheyeWidth(100, 100 + 90)
    expect(near).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(far)
    expect(far).toBeGreaterThan(MIN_W)
  })

  it('对称：上下等距时宽度相等', () => {
    expect(calcFisheyeWidth(100, 100 + 50)).toBe(calcFisheyeWidth(100, 100 - 50))
  })

  it('中心处 factor=1：宽度恰为 maxW', () => {
    expect(calcFisheyeWidth(0, 0)).toBe(MAX_W)
  })

  it('支持自定义参数（maxW/minW/range）', () => {
    const w = calcFisheyeWidth(0, 0, { maxW: 300, minW: 12, range: 200 })
    expect(w).toBe(300)
    expect(calcFisheyeWidth(0, 1000, { maxW: 300, minW: 12, range: 200 })).toBe(12)
  })

  it('结果始终落在 [minW, maxW] 闭区间内', () => {
    for (let d = 0; d <= RANGE; d += 7) {
      const w = calcFisheyeWidth(0, d)
      expect(w).toBeGreaterThanOrEqual(MIN_W)
      expect(w).toBeLessThanOrEqual(MAX_W)
    }
  })
})
