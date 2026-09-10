/**
 * math-breakthroughs.test.ts - P2-S2 幽灵裁剪后仅保留在役模块
 * （ConformalHallucinationDetector / ThompsonRouter / RateDistortionCompressor）；
 * VIBCompressor / ConformalRetriever / ConsensusEngine 模块已随休眠链归档删除。
 */
import { describe, it, expect } from "bun:test";
import { ConformalHallucinationDetector, type FactEntry } from "../src/memory/hallucination-detector";
import { ThompsonRouter, type RouterArm, type RoutingContext, createThompsonRouter } from "../src/router/thompson-router";
import { RateDistortionCompressor, type ContextItem, contextEntropy, contextRedundancy } from "../src/context/rate-distortion-compressor";

describe("ConformalHallucinationDetector", () => {
  const facts:FactEntry[] = [
    {text:"earth orbits sun",confidence:1,source:"astro"},
    {text:"water boils 100 celsius",confidence:1,source:"phys"},
    {text:"paris is capital of france",confidence:1,source:"geo"},
  ];
  it("true facts verified", () => {
    const d = new ConformalHallucinationDetector({alpha:0.1,factBase:facts});
    d.calibrate([{statement:"earth revolves around sun",isFact:true},{statement:"H2O boils at 100C",isFact:true}]);
    const r = d.verify("earth orbits sun");
    expect(r.isHallucination).toBe(false);
    expect(r.evidence.length).toBeGreaterThan(0);
  });
  it("unknown claims have no evidence", () => {
    const d = new ConformalHallucinationDetector({alpha:0.1,factBase:facts});
    const r = d.verify("dragons breathe fire");
    expect(r.evidence.length).toBe(0);
  });
  it("valid p-value range", () => {
    const d = new ConformalHallucinationDetector({alpha:0.1,factBase:facts});
    d.calibrate([{statement:"sky is blue",isFact:true},{statement:"sky is green",isFact:false}]);
    const r = d.verify("earth orbits sun");
    expect(r.pValue).toBeGreaterThan(0);
    expect(r.pValue).toBeLessThanOrEqual(1);
  });
});

describe("ThompsonRouter", () => {
  it("cold start fallback", async () => {
    const arms:RouterArm[] = [{id:"m1",model:"a",provider:"p1",alpha:1,beta:1,metadata:{ctx:4096}},{id:"m2",model:"b",provider:"p2",alpha:1,beta:1,metadata:{ctx:8192}}];
    const router = createThompsonRouter({arms,minSamples:5,inMemory:true});
    const ctx:RoutingContext = {taskType:"general-chat",inputLength:500,timeWindow:10000};
    const d = await router.route(ctx);
    expect(d.arm).toBeDefined();
    expect(d.reason!.toLowerCase()).toContain("thompson");
  });
  it("feedback updates stats", async () => {
    const arms:RouterArm[] = [{id:"a1",model:"x",provider:"p",alpha:1,beta:1,metadata:{}}];
    const router = createThompsonRouter({arms,minSamples:0,inMemory:true});
    router.reportFeedback("a1",true);
    const s = router.getArmStats().find(s=>s.id==="a1")!;
    expect(s.alpha).toBeGreaterThan(s.beta);
    expect(s.mean).toBeGreaterThan(0.5);
  });
  it("good arm wins more", async () => {
    const good:RouterArm = {id:"good",model:"g",provider:"pg",alpha:10,beta:2,metadata:{}};
    const bad:RouterArm = {id:"bad",model:"b",provider:"pb",alpha:2,beta:10,metadata:{}};
    const router = createThompsonRouter({arms:[good,bad],minSamples:0,inMemory:true});
    let wins = 0;
    for(let i=0;i<50;i++){if((await router.route({taskType:"chat",inputLength:500,timeWindow:10000})).arm.id==="good")wins++}
    expect(wins).toBeGreaterThan(25);
  });
});

describe("RateDistortionCompressor", () => {
  const mi = (id:string,content:string,r=0.8,t=10):ContextItem => ({id,content,relevance:r,tokens:t});
  it("compression with permissive D_max", async () => {
    const c = new RateDistortionCompressor({maxDistortion:0.95,minRate:0.1});
    const items = [mi("k1","valuable info",0.95,30),mi("d1","trash",0.02,15),mi("k2","critical",0.9,25)];
    const r = await c.compress(items);
    expect(r.stats.compressedTokens).toBeLessThanOrEqual(r.stats.originalTokens);
    expect(r.rate).toBeGreaterThanOrEqual(0);
    expect(r.rate).toBeLessThanOrEqual(1);
  });
  it("keeps high relevance items", async () => {
    const c = new RateDistortionCompressor({maxDistortion:0.95,minRate:0.1});
    const items = [mi("keep","important",0.95,30),mi("drop","noise",0.01,10)];
    const r = await c.compress(items);
    expect(r.items.map(i=>i.id)).toContain("keep");
  });
  it("entropy non-negative",()=>{expect(contextEntropy([mi("a","hello",1,3)])).toBeGreaterThanOrEqual(0)});
  it("redundancy in range",()=>{const v=contextRedundancy([mi("a","test",1,3)]);expect(v).toBeGreaterThanOrEqual(0);expect(v).toBeLessThanOrEqual(1)});
});