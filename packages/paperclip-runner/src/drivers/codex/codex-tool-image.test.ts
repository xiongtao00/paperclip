import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dynamicToolResponse } from "./codex-driver-values.js";
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=", "base64");
const image = { schema: "paperclip.tool-image.v1", mimeType: "image/png", data: bytes.toString("base64"), metadata: { sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, contentTrust: "untrusted_attachment" } };
describe("Codex original image tool output", () => {
  it("delivers pixels through the provider image item instead of serializing them as text", () => {
    expect(dynamicToolResponse(image)).toEqual({ success: true, contentItems: [
      { type: "inputText", text: JSON.stringify({ ...image.metadata, image_url: `data:image/png;base64,${image.data}` }) },
      { type: "inputImage", imageUrl: `data:image/png;base64,${image.data}` },
    ] });
    expect(dynamicToolResponse({ count: 3 })).toEqual({ success: true, contentItems: [{ type: "inputText", text: '{"count":3}' }] });
  });
  it.each([{ ...image, data: "not-an-image" }, { ...image, mimeType: "image/svg+xml" }, { ...image, metadata: { ...image.metadata, sha256: "0".repeat(64) } }, { ...image, data: "A".repeat(400001) }])("rejects an invalid or changed image", bad => {
    expect(() => dynamicToolResponse(bad)).toThrow("Invalid verified tool image");
  });
});
