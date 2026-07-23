import { describe, expect, it } from "vitest";
import { resolveVoiceFeatureUiEnabled } from "@/hooks/voice-feature-ui-enabled";

describe("resolveVoiceFeatureUiEnabled", () => {
  it("hides when daemon config disables the feature even if capability is still on", () => {
    expect(
      resolveVoiceFeatureUiEnabled({
        config: {
          mcp: { injectIntoAgents: true },
          browserTools: { enabled: false },
          dictation: { enabled: false },
          voiceMode: { enabled: true },
          providers: {},
          metadataGeneration: { providers: [] },
          autoArchiveAfterMerge: false,
          enableTerminalAgentHooks: false,
          appendSystemPrompt: "",
        },
        serverInfo: {
          serverId: "srv",
          hostname: "host",
          version: "1",
          capabilities: {
            voice: {
              dictation: { enabled: true, reason: "" },
              voice: { enabled: true, reason: "" },
            },
          },
        },
        mode: "dictation",
      }),
    ).toBe(false);
  });

  it("hides when capability reports disabled", () => {
    expect(
      resolveVoiceFeatureUiEnabled({
        config: null,
        serverInfo: {
          serverId: "srv",
          hostname: "host",
          version: "1",
          capabilities: {
            voice: {
              dictation: { enabled: false, reason: "Dictation is disabled in daemon config." },
              voice: { enabled: true, reason: "" },
            },
          },
        },
        mode: "dictation",
      }),
    ).toBe(false);
  });

  it("keeps UI when config and capability are on or absent", () => {
    expect(
      resolveVoiceFeatureUiEnabled({
        config: null,
        serverInfo: null,
        mode: "voice",
      }),
    ).toBe(true);
  });
});
