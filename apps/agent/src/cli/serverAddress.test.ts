import { describe, expect, it } from "vitest";
import { parseServerAddress } from "./serverAddress.js";

describe("parseServerAddress", () => {
  it("parses a plain host", () => {
    expect(parseServerAddress("10.0.0.5")).toEqual({ host: "10.0.0.5" });
    expect(parseServerAddress("  tallyserver  ")).toEqual({ host: "tallyserver" });
  });

  it("parses HOST\\INSTANCE into host + instanceName, no port", () => {
    expect(parseServerAddress("TALLYSERVER\\SQL2008ERP")).toEqual({
      host: "TALLYSERVER",
      instanceName: "SQL2008ERP",
    });
  });

  it("trims whitespace around each half of HOST\\INSTANCE", () => {
    expect(parseServerAddress(" TALLYSERVER \\ SQL2008ERP ")).toEqual({
      host: "TALLYSERVER",
      instanceName: "SQL2008ERP",
    });
  });

  it("parses HOST,PORT into host + port", () => {
    expect(parseServerAddress("10.0.0.5,1433")).toEqual({ host: "10.0.0.5", port: 1433 });
    expect(parseServerAddress("tallyserver, 14330")).toEqual({ host: "tallyserver", port: 14330 });
  });

  it("falls back to a plain host when the instance half is empty", () => {
    expect(parseServerAddress("TALLYSERVER\\")).toEqual({ host: "TALLYSERVER\\" });
  });

  it("falls back to a plain host when the port half isn't a valid port number", () => {
    expect(parseServerAddress("10.0.0.5,abc")).toEqual({ host: "10.0.0.5,abc" });
    expect(parseServerAddress("10.0.0.5,")).toEqual({ host: "10.0.0.5," });
    expect(parseServerAddress("10.0.0.5,999999")).toEqual({ host: "10.0.0.5,999999" });
  });
});
