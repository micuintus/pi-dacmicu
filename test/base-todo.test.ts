import { strict as assert } from "node:assert";
import baseFactory from "../packages/base/index.js";
import { attachLoopDriver } from "../packages/base/index.js";

assert.equal(typeof attachLoopDriver, "function");
console.log("✓ attachLoopDriver exported");

const mockPi = {
	on: () => {},
	registerCommand: () => {},
} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

baseFactory(mockPi);
console.log("✓ Base extension factory loads without error");

console.log("\n🎉 Base minimal tests passed.");
