import { describe, expect, it } from "bun:test";
import {
  containsAll,
  containsAny,
  extractJSON,
  hasJSONKeys,
  matchesAll,
  minLength,
  notContains,
} from "../../src/agent-evals/verify.js";

describe("verify helpers", () => {
  it("containsAll passes when all needles present", () => {
    expect(containsAll("Hello World Foo", ["hello", "world"]).passed).toBe(true);
    expect(containsAll("Hello World", ["foo"]).passed).toBe(false);
  });

  it("containsAny passes when at least one needle present", () => {
    expect(containsAny("a b", ["a", "z"]).passed).toBe(true);
    expect(containsAny("a b", ["x", "z"]).passed).toBe(false);
  });

  it("matchesAll applies regexes", () => {
    expect(matchesAll("fetch(url)", [/fetch/, /\(/]).passed).toBe(true);
    expect(matchesAll("fetch url", [/fetch/, /\(/]).passed).toBe(false);
  });

  it("notContains rejects banned text", () => {
    expect(notContains("safe answer", ["danger"]).passed).toBe(true);
    expect(notContains("this is danger", ["danger"]).passed).toBe(false);
  });

  it("extracts JSON from fenced code blocks", () => {
    const obj = extractJSON('\`\`\`json\n{"a": 1}\n\`\`\`');
    expect(obj).toEqual({ a: 1 });
  });

  it("hasJSONKeys checks required keys", () => {
    expect(hasJSONKeys('{"name":"x","age":1}', ["name", "age"]).passed).toBe(true);
    expect(hasJSONKeys('{"name":"x"}', ["age"]).passed).toBe(false);
    expect(hasJSONKeys("no json here", ["age"]).passed).toBe(false);
  });

  it("minLength rejects empty answers", () => {
    expect(minLength("   ", 5).passed).toBe(false);
    expect(minLength("hello world", 5).passed).toBe(true);
  });
});
