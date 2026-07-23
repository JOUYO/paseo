import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { DaemonServerInfo } from "@/stores/session-store";
import { isVoiceFeatureEnabled, type VoiceReadinessMode } from "@/utils/server-info-capabilities";

/**
 * Whether the composer should show a voice feature control.
 * Daemon config is authoritative as soon as the Settings toggle patches
 * (capabilities lag until speech runtime finishes reconfigure).
 */
export function resolveVoiceFeatureUiEnabled(input: {
  config: MutableDaemonConfig | null;
  serverInfo: DaemonServerInfo | null | undefined;
  mode: VoiceReadinessMode;
}): boolean {
  if (input.config) {
    const fromConfig =
      input.mode === "dictation"
        ? input.config.dictation?.enabled
        : input.config.voiceMode?.enabled;
    if (fromConfig === false) {
      return false;
    }
  }

  const capabilityEnabled = isVoiceFeatureEnabled({
    serverInfo: input.serverInfo,
    mode: input.mode,
  });
  if (capabilityEnabled === false) {
    return false;
  }

  return true;
}
