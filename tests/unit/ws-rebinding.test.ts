import { checkWsUpgradeAuth } from "../../src/utils/ws-auth.js";
import { describe, test, expect } from "bun:test";
describe("ws rebinding", () => {
  test("local + evil Origin without cred -> deny", () => {
    expect(checkWsUpgradeAuth({ headerAuth:null, protocolHeader:null, queryToken:null, isLocal:true, apiKey:"secret", origin:"http://r.evil.com", host:"r.evil.com" }).ok).toBe(false);
  });
  test("local + evil Origin with valid cred -> allow", () => {
    expect(checkWsUpgradeAuth({ headerAuth:"secret", protocolHeader:null, queryToken:null, isLocal:true, apiKey:"secret", origin:"http://r.evil.com", host:"r.evil.com" }).ok).toBe(true);
  });
  test("local no Origin -> allow", () => {
    expect(checkWsUpgradeAuth({ headerAuth:null, protocolHeader:null, queryToken:null, isLocal:true, apiKey:"secret" }).ok).toBe(true);
  });
});
