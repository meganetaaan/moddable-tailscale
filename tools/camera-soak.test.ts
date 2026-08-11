import { runCameraSoak } from "./camera-soak.ts";

Deno.test("sustains two isolated virtual cameras at detail-view 8fps", async () => {
  await runCameraSoak({
    durationMs: 2_000,
    deviceCount: 2,
    fps: 8,
    progressIntervalMs: 1_000,
    log() {},
  });
});
