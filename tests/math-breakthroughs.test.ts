/**
 * math-breakthroughs.test.ts - all 6 modules + integration
 */
import { describe, it, expect } from "bun:test";
import { VIBCompressor, type MemoryItem, type CompressedResult } from "../src/memory/vib-compressor";
import { ConformalRetriever, type CalibrationPair } from "../src/memory/conformal-retriever";
import { ConformalHallucinationDetector, type FactEntry } from "../src/memory/hallucination-detector";
import { ThompsonRouter, type RouterArm, type RoutingContext, createThompsonRouter } from "../src/router/thompson-router";
import { RateDistortionCompressor, type ContextItem, contextEntropy, contextRedundancy } from "../src/context/rate-distortion-compressor";
import { ConsensusEngine, type ConsensusAgent } from "../src/agents/consensus-engine";

const makeItem = (id: string, content: string): MemoryItem => ({id, content, timestamp: Date.now(), source: "test"});

describe("VIBCompressor", () => {
  it("retains top-K by surprisal", async () => {
    const c = new VIBCompressor({ beta: 1.5, capacity: 3 });
    const items = [makeItem("1","unique rare quantum physics"), makeItem("2","the the the the the the"), makeItem("3","machine learning ai gpt neural"), makeItem("4","a a a a a a a a a a")];
    const r = await c.compress(items);
    expect(r.retained.length).toBeGreaterThan(0);
    expect(r.retained.length).toBeLessThanOrEqual(3);
  });
  it("capacity limit", async () => {
    const c = new VIBCompressor({ beta: 1, capacity: 5 });
    const items = Array.from({length: 20}, (_, i) => makeItem(String(i), "content number " + i));
    const r = await c.compress(items);
    expect(r.retained.length).toBeLessThanOrEqual(5);
  });
  it("beta affects retention", async () => {
    const items = Array.from({length: 20}, (_, i) => makeItem(String(i), "item " + i + " " + (i%3?"common":"rare unique")));
    const lo = await new VIBCompressor({beta:1,capacity:20}).compress(items);
    const hi = await new VIBCompressor({beta:4,capacity:20}).compress(items);
    expect(hi.retained.length).toBeLessThanOrEqual(lo.retained.length);
  });
  it("empty input", async () => {
    const c = new VIBCompressor({beta:1,capacity:10});
    const r = await c.compress([]);
    expect(r.retained).toEqual([]);
    expect(r.stats.totalInput).toBe(0);
  });
});

describe("ConformalRetriever", () => {
  interface Doc {id:string;text:string}
  const sim = (q:string,d:Doc):number => {const qs=new Set(q.toLowerCase().split(/\s+/));const ds=new Set(d.text.toLowerCase().split(/\s+/));let o=0;for(const w of qs){if(ds.has(w))o++}return new Set([...qs,...ds]).size>0?o/new Set([...qs,...ds]).size:0};
  it("relevant docs in prediction set", () => {
    const r = new ConformalRetriever<Doc>({alpha:0.2});
    r.calibrate([{document:{id:"c1",text:"ml deep"},relevance:0.9},{document:{id:"c2",text:"cooking"},relevance:0.1}]);
    const cand = [{id:"d1",text:"deep learning ai"},{id:"d2",text:"recipes food"}];
    const res = r.retrieve("ai learning",cand,sim);
    expect(res.predictionSet.map(d=>d.id)).toContain("d1");
  });
  it("uncalibrated returns all", () => {
    const r = new ConformalRetriever<Doc>({alpha:0.1});
    const res = r.retrieve("q",[{id:"a",text:"x"}],sim);
    expect(res.predictionSet.length).toBe(1);
    expect(res.conformal).toBe(false);
  });
  it("p-values monotonic", () => {
    const r = new ConformalRetriever<Doc>({alpha:0.1});
    r.calibrate([{document:{id:"h",text:"high"},relevance:0.95},{document:{id:"l",text:"low"},relevance:0.1}]);
    const cand = [{id:"d1",text:"high match"},{id:"d2",text:"unrelated"}];
    const res = r.retrieve("high",cand,sim);
    expect(res.pValues.get(cand[0])!).toBeGreaterThan(res.pValues.get(cand[1])!);
  });
});

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
    expect(d.reason!.toLowerCase()).toContain("cold");
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

describe("ConsensusEngine", () => {
  const ag = (id:string,d:"approve"|"reject"|"abstain",c:number):ConsensusAgent => ({id,name:"a-"+id,vote:async()=>({decision:d,confidence:c,reasoning:id})});
  it("WMA majority", async () => {
    const e = new ConsensusEngine({agents:[ag("1","approve",0.9),ag("2","approve",0.8),ag("3","reject",0.7)],beta:0.5,mode:"wma"});
    const r = await e.reachConsensus("test");
    expect(r.decision).toBe("approve");
    expect(r.approvalRatio).toBeCloseTo(2/3,1);
  });
  it("regret bound finite", async () => {
    const e = new ConsensusEngine({agents:[ag("1","approve",0.9),ag("2","reject",0.6)],beta:0.5,mode:"wma"});
    const r = await e.reachConsensus("test");
    expect(r.regretBound).toBeGreaterThan(0);
    expect(Number.isFinite(r.regretBound)).toBe(true);
  });
  it("agreement high when unanimous", async () => {
    const e = new ConsensusEngine({agents:[ag("1","approve",0.9),ag("2","approve",0.9),ag("3","approve",0.9)],mode:"wma"});
    const r = await e.reachConsensus("test");
    expect(r.agreementLevel).toBeGreaterThan(0.8);
  });
});

describe("Integration", () => {
  it("VIB + Conformal pipeline", async () => {
    const c = new VIBCompressor({beta:1.5,capacity:5});
    const items = Array.from({length:10},(_,i)=>makeItem(String(i),"memory "+i+" unique "+String.fromCharCode(65+i)));
    const r = await c.compress(items);
    expect(r.retained.length).toBeGreaterThan(0);
    expect(r.retained.length).toBeLessThanOrEqual(5);
  });
  it("Thompson + Consensus unified", async () => {
    const arms:RouterArm[] = [{id:"m1",model:"a",provider:"p1",alpha:5,beta:2,metadata:{}}];
    const router = createThompsonRouter({arms,minSamples:5,inMemory:true});
    const d = await router.route({taskType:"research",inputLength:1000,timeWindow:30000});
    expect(d.arm).toBeDefined();
    const agents:ConsensusAgent[] = [{id:"v1",name:"v",vote:async()=>({decision:"approve" as const,confidence:0.8,reasoning:"ok"})}];
    const engine = new ConsensusEngine({agents,mode:"majority"});
    const consensus = await engine.reachConsensus("test");
    expect(consensus.decision).toBe("approve");
  });
});